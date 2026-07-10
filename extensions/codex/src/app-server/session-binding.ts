/** SQLite-backed Codex app-server thread bindings. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ensureAuthProfileStore,
  resolveDefaultAgentDir,
  resolveProviderIdForAuth,
  resolveSessionAgentIds,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { z } from "zod";
import { CODEX_PLUGINS_MARKETPLACE_NAME, normalizeCodexServiceTier } from "./config.js";
import type { PluginAppPolicyContext } from "./plugin-thread-config.js";
import type { CodexServiceTier } from "./protocol.js";

const CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER = "openai";
const PUBLIC_OPENAI_MODEL_PROVIDER = "openai";
const BINDING_LEASE_RETRY_INTERVAL_MS = 1_000;

export {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-meta.js";
export const CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const BINDING_LEASE_STALE_MS = CODEX_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 5_000;
const BINDING_LEASE_WAIT_MS = BINDING_LEASE_STALE_MS + 5_000;
const BINDING_LEASE_RENEW_INTERVAL_MS = Math.floor(BINDING_LEASE_STALE_MS / 3);
// Physical session keys cannot have a successor generation. Retain their
// retirement fence only long enough for bounded stale lease work to drain.
const PHYSICAL_SESSION_RETIRE_TTL_MS = BINDING_LEASE_WAIT_MS;

type ProviderAuthAliasLookupParams = Parameters<typeof resolveProviderIdForAuth>[1];
type ProviderAuthAliasConfig = NonNullable<ProviderAuthAliasLookupParams>["config"];

/** Inputs needed to resolve whether a binding's auth profile is native Codex/OpenAI auth. */
export type CodexAppServerAuthProfileLookup = {
  authProfileId?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
};

/** Stable owner of one Codex thread binding. */
export type CodexAppServerBindingIdentity =
  | { kind: "session"; agentId: string; sessionId: string; sessionKey?: string }
  | { kind: "conversation"; bindingId: string };

/** Resolves the same agent scope OpenClaw uses for transcript/session ownership. */
export function sessionBindingIdentity(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): Extract<CodexAppServerBindingIdentity, { kind: "session" }> {
  const { sessionAgentId } = resolveSessionAgentIds(params);
  const sessionKey = params.sessionKey?.trim();
  return {
    kind: "session",
    agentId: sessionAgentId,
    sessionId: params.sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

const optionalStringSchema = z.string().optional().catch(undefined);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const optionalNonBlankStringSchema = z
  .string()
  .refine((value) => Boolean(value.trim()))
  .optional()
  .catch(undefined);
const optionalTimestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)))
  .optional()
  .catch(undefined);
const contextEngineProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("thread_bootstrap"),
    epoch: z.string().refine((value) => Boolean(value.trim())),
    fingerprint: optionalStringSchema,
  })
  .strict();
const contextEngineSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineId: z.string(),
    policyFingerprint: z.string(),
    projection: contextEngineProjectionSchema.optional().catch(undefined),
  })
  .strict();
const destructiveApprovalModeSchema = z
  .enum(["allow", "deny", "auto", "ask"])
  .optional()
  .catch(undefined);
// Account-connected apps are admitted without a plugin package; both entry
// shapes must round-trip or stored policy context silently drops on read.
const accountAppPolicyEntrySchema = z
  .object({
    source: z.literal("account"),
    appName: z.string(),
    allowDestructiveActions: z.boolean(),
    destructiveApprovalMode: destructiveApprovalModeSchema,
    mcpServerNames: z.array(z.string()),
  })
  .strict();
const pluginAppPolicyEntrySchema = z
  .object({
    source: z.literal("plugin").optional(),
    configKey: z.string(),
    marketplaceName: z.literal(CODEX_PLUGINS_MARKETPLACE_NAME),
    pluginName: z.string(),
    allowDestructiveActions: z.boolean(),
    destructiveApprovalMode: destructiveApprovalModeSchema,
    mcpServerNames: z.array(z.string()),
  })
  .strict();
const pluginAppPolicyContextSchema = z
  .object({
    fingerprint: z.string(),
    apps: z.record(z.string(), z.union([accountAppPolicyEntrySchema, pluginAppPolicyEntrySchema])),
    pluginAppIds: z.record(z.string(), z.array(z.string())).default({}),
  })
  .strict();
const threadBindingSchema = z.object({
  threadId: z.string().refine((value) => Boolean(value.trim())),
  cwd: z.string(),
  authProfileId: optionalStringSchema,
  model: optionalStringSchema,
  modelProvider: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1))
    .optional()
    .catch(undefined),
  approvalPolicy: z
    .preprocess(
      (value) => (value === "on-failure" ? "on-request" : value),
      z.enum(["never", "on-request", "untrusted"]).optional(),
    )
    .catch(undefined),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .optional()
    .catch(undefined),
  serviceTier: z
    .preprocess(
      normalizeCodexServiceTier,
      z.custom<CodexServiceTier>((value) => typeof value === "string").optional(),
    )
    .optional()
    .catch(undefined),
  networkProxyProfileName: optionalStringSchema,
  networkProxyConfigFingerprint: optionalStringSchema,
  dynamicToolsFingerprint: optionalStringSchema,
  dynamicToolsContainDeferred: optionalBooleanSchema,
  webSearchThreadConfigFingerprint: optionalStringSchema,
  userMcpServersFingerprint: optionalStringSchema,
  mcpServersFingerprint: optionalStringSchema,
  nativeHookRelayGeneration: optionalNonBlankStringSchema,
  appServerRuntimeFingerprint: optionalStringSchema,
  pluginAppsFingerprint: optionalStringSchema,
  pluginAppsInputFingerprint: optionalStringSchema,
  pluginAppPolicyContext: pluginAppPolicyContextSchema.optional().catch(undefined),
  contextEngine: contextEngineSchema.optional().catch(undefined),
  environmentSelectionFingerprint: optionalStringSchema,
  conversationStartId: optionalStringSchema,
  conversationSourceTransferComplete: z.literal(true).optional().catch(undefined),
  historyCoveredThrough: optionalTimestampSchema,
});

/** Durable Codex thread facts. Storage identity and schema stay outside this domain value. */
export type CodexAppServerThreadBinding = z.infer<typeof threadBindingSchema>;
/** Context-engine state persisted with a Codex app-server thread binding. */
export type CodexAppServerContextEngineBinding = z.infer<typeof contextEngineSchema>;
/** Context-engine projection metadata used to guard resumed native threads. */
export type CodexAppServerContextEngineProjectionBinding = z.infer<
  typeof contextEngineProjectionSchema
>;

type CodexAppServerBindingMutation =
  | {
      kind: "set";
      binding: CodexAppServerThreadBinding;
      if?: { kind: "absent" };
    }
  | {
      kind: "patch";
      threadId: string;
      patch: Partial<Omit<CodexAppServerThreadBinding, "threadId">>;
    }
  | {
      kind: "reclaim-generation";
      expectedPreviousSessionId: string;
    }
  | { kind: "clear"; threadId?: string };

export type CodexSessionGenerationAdoptionResult = "adopted" | "current" | "absent" | "conflict";

export type CodexSessionGenerationRetirementResult = "applied" | "absent" | "conflict";

export type CodexSessionGenerationReclaimPlan =
  | { kind: "resolved"; result: boolean }
  | { kind: "verify"; expectedPreviousSessionId: string };

const bindingLeaseSchema = z.object({
  token: z.string().refine((value) => Boolean(value.trim())),
  expiresAt: z.number().finite(),
});
const storedSessionIdSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1))
  .optional()
  .catch(undefined);
const storedBindingSchema = z.discriminatedUnion("state", [
  z.object({
    version: z.literal(1),
    state: z.literal("active"),
    binding: threadBindingSchema,
    sessionId: storedSessionIdSchema,
    lease: bindingLeaseSchema.optional().catch(undefined),
  }),
  z.object({
    version: z.literal(1),
    state: z.literal("cleared"),
    sessionId: storedSessionIdSchema,
    lease: bindingLeaseSchema.optional().catch(undefined),
    retired: z.literal(true).optional().catch(undefined),
  }),
]);

// Session-key rows survive transcript/session-id rotation. The stored physical
// id fences delayed lifecycle cleanup so an old generation cannot clear its successor.
export type StoredCodexAppServerBinding = z.infer<typeof storedBindingSchema>;

/** Encodes a migrated sidecar binding as one canonical plugin-state row. */
export function createStoredCodexAppServerBinding(
  value: unknown,
  options: {
    now?: string;
    lookup?: Omit<CodexAppServerAuthProfileLookup, "authProfileId">;
  } = {},
): Extract<StoredCodexAppServerBinding, { state: "active" }> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    return undefined;
  }
  const pluginAppPolicyContext = readPluginAppPolicyContext(
    record.pluginAppPolicyContext,
    record.schemaVersion,
  );
  const historyCoveredThrough =
    readTimestamp(record.historyCoveredThrough) ??
    readTimestamp(record.updatedAt) ??
    readTimestamp(record.createdAt) ??
    readTimestamp(options.now) ??
    new Date().toISOString();
  const authProfileId = typeof record.authProfileId === "string" ? record.authProfileId : undefined;
  const binding = readCodexAppServerThreadBinding({
    ...record,
    modelProvider: normalizeCodexAppServerBindingModelProvider({
      ...options.lookup,
      authProfileId,
      modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
    }),
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    pluginAppPolicyContext,
    historyCoveredThrough,
  });
  return binding
    ? {
        version: 1,
        state: "active",
        binding: stripUndefinedBinding(binding),
      }
    : undefined;
}

type BindingStateStore = Pick<
  PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
  "lookup" | "update"
>;

type BindingLeaseOwner = {
  token: string;
  failure?: Error;
};

function bindingLeaseLostError(key: string, cause?: unknown): Error {
  return new Error(`Lost Codex binding lease: ${key}`, cause === undefined ? undefined : { cause });
}

export type CodexAppServerBindingStore = {
  read(identity: CodexAppServerBindingIdentity): Promise<CodexAppServerThreadBinding | undefined>;
  mutate(
    identity: CodexAppServerBindingIdentity,
    mutation: CodexAppServerBindingMutation,
  ): Promise<boolean>;
  prepareSessionGenerationReclaim(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationReclaimPlan>;
  adoptSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
    expectedPreviousSessionId: string,
  ): Promise<CodexSessionGenerationAdoptionResult>;
  retireSessionGeneration(
    identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>,
  ): Promise<CodexSessionGenerationRetirementResult>;
  withLease<T>(identity: CodexAppServerBindingIdentity, run: () => Promise<T>): Promise<T>;
};

/** Lets the authoritative OpenClaw session generation claim a stale stable binding row. */
export async function reclaimCurrentCodexSessionGeneration(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  config?: OpenClawConfig;
}): Promise<boolean> {
  const sessionKey = params.identity.sessionKey?.trim();
  if (!sessionKey) {
    return true;
  }
  const plan = await params.bindingStore.prepareSessionGenerationReclaim(params.identity);
  if (plan.kind === "resolved") {
    return plan.result;
  }

  // Only a stale stable-key owner needs filesystem authority. Resolve it before
  // the second mutation so session JSON work never runs inside SQLite's write transaction.
  try {
    const storePath = resolveStorePath(params.config?.session?.store, {
      agentId: params.identity.agentId,
    });
    const entry = resolveSessionStoreEntry({
      store: loadSessionStore(storePath, {
        skipCache: true,
        hydrateSkillPromptRefs: false,
      }),
      sessionKey,
    }).existing;
    if (entry?.sessionId !== params.identity.sessionId) {
      return false;
    }
  } catch {
    return false;
  }
  return await params.bindingStore.mutate(params.identity, {
    kind: "reclaim-generation",
    expectedPreviousSessionId: plan.expectedPreviousSessionId,
  });
}

/** Creates the single binding facade owned by the Codex plugin runtime. */
export function createCodexAppServerBindingStore(
  state: BindingStateStore,
): CodexAppServerBindingStore {
  const update = state.update?.bind(state);
  if (!update) {
    throw new Error("Codex app-server bindings require atomic plugin-state updates");
  }
  const leaseContext = new AsyncLocalStorage<Map<string, BindingLeaseOwner>>();

  const renewLease = (key: string, owner: BindingLeaseOwner): void => {
    if (owner.failure) {
      return;
    }
    try {
      let renewed = false;
      const stored = update(key, (raw) => {
        const current = readStoredCodexAppServerBinding(raw);
        if (raw !== undefined && !current) {
          throw new Error(`Invalid Codex app-server binding row: ${key}`);
        }
        const lease = current?.lease;
        const now = Date.now();
        if (!lease || lease.token !== owner.token || lease.expiresAt <= now) {
          return undefined;
        }
        renewed = true;
        return {
          ...current,
          lease: { token: owner.token, expiresAt: now + BINDING_LEASE_STALE_MS },
        };
      });
      if (!renewed || !stored) {
        owner.failure = bindingLeaseLostError(key);
      }
    } catch (error) {
      owner.failure = bindingLeaseLostError(key, error);
    }
  };

  const transactKey = async <T>(
    key: string,
    apply: (
      current: StoredCodexAppServerBinding | undefined,
      leaseToken?: string,
    ) => {
      next?: StoredCodexAppServerBinding;
      result: T;
    },
    ttlMs?: number,
  ): Promise<T> => {
    const deadline = Date.now() + BINDING_LEASE_WAIT_MS;
    while (true) {
      let busy = false;
      let leaseLost = false;
      let result!: T;
      const ownedLease = leaseContext.getStore()?.get(key);
      if (ownedLease?.failure) {
        throw ownedLease.failure;
      }
      const ownedToken = ownedLease?.token;
      update(
        key,
        (raw) => {
          const current = readStoredCodexAppServerBinding(raw);
          if (raw !== undefined && !current) {
            throw new Error(`Invalid Codex app-server binding row: ${key}`);
          }
          const activeLease = current?.lease;
          const now = Date.now();
          if (
            ownedToken &&
            (!activeLease || activeLease.token !== ownedToken || activeLease.expiresAt <= now)
          ) {
            leaseLost = true;
            return undefined;
          }
          if (activeLease && activeLease.token !== ownedToken && activeLease.expiresAt > now) {
            busy = true;
            return undefined;
          }
          const applied = apply(current, ownedToken);
          result = applied.result;
          return applied.next;
        },
        ttlMs == null ? undefined : { ttlMs },
      );
      if (leaseLost) {
        const failure = bindingLeaseLostError(key);
        if (ownedLease) {
          ownedLease.failure = failure;
        }
        throw failure;
      }
      if (!busy) {
        return result;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Codex binding lease: ${key}`);
      }
      await sleep(BINDING_LEASE_RETRY_INTERVAL_MS);
    }
  };

  return {
    async read(identity) {
      const key = bindingStoreKey(identity);
      const raw = state.lookup(key);
      const stored = readStoredCodexAppServerBinding(raw);
      if (raw !== undefined && !stored) {
        throw new Error(`Invalid Codex app-server binding row: ${key}`);
      }
      return stored?.state === "active" && ownsStoredSessionGeneration(identity, stored)
        ? stored.binding
        : undefined;
    },

    async prepareSessionGenerationReclaim(identity) {
      const key = bindingStoreKey(identity);
      const raw = state.lookup(key);
      const current = readStoredCodexAppServerBinding(raw);
      if (raw !== undefined && !current) {
        throw new Error(`Invalid Codex app-server binding row: ${key}`);
      }
      if (!current) {
        return { kind: "resolved", result: true };
      }
      const currentSessionId = current.sessionId;
      if (!currentSessionId || currentSessionId === identity.sessionId) {
        return {
          kind: "resolved",
          result: current.state !== "cleared" || current.retired !== true,
        };
      }
      return { kind: "verify", expectedPreviousSessionId: currentSessionId };
    },

    async mutate(identity, mutation) {
      const key = bindingStoreKey(identity);
      // A retained legacy sidecar may be revisited by doctor after runtime
      // clear. Keep provenance so migration cannot resurrect its stale thread.
      const retainLegacyClear = mutation.kind === "clear" && key.startsWith("conversation:legacy-");
      return await transactKey(
        key,
        (current, leaseToken) => {
          const ownsGeneration = ownsStoredSessionGeneration(identity, current);
          const ownedLease =
            current?.lease && current.lease.token === leaseToken ? { lease: current.lease } : {};
          if (mutation.kind === "reclaim-generation") {
            if (identity.kind !== "session" || !identity.sessionKey?.trim()) {
              return { result: false };
            }
            if (!current) {
              return { result: true };
            }
            if (ownsGeneration) {
              return {
                result: current.state !== "cleared" || current.retired !== true,
              };
            }
            if (current.sessionId !== mutation.expectedPreviousSessionId) {
              return { result: false };
            }
            return {
              result: true,
              next: {
                version: 1,
                state: "cleared",
                sessionId: identity.sessionId,
                ...ownedLease,
              },
            };
          }
          const storedActive = current?.state === "active" ? current : undefined;
          const active = ownsGeneration ? storedActive : undefined;
          const retiredGeneration =
            current?.state === "cleared" && current.retired === true && ownsGeneration;
          if (
            (mutation.kind === "set" &&
              ((mutation.if?.kind === "absent" && storedActive) ||
                (current !== undefined && !ownsGeneration) ||
                retiredGeneration)) ||
            (mutation.kind === "patch" && active?.binding.threadId !== mutation.threadId) ||
            (mutation.kind === "clear" &&
              ((mutation.threadId !== undefined &&
                active?.binding.threadId !== mutation.threadId) ||
                !ownsGeneration))
          ) {
            return { result: false };
          }
          if (mutation.kind === "clear" && retiredGeneration) {
            return { result: true };
          }
          if (mutation.kind === "clear") {
            return {
              result: true,
              next: {
                version: 1,
                state: "cleared",
                ...storedSessionGeneration(identity, current),
                ...ownedLease,
              },
            };
          }
          let binding: CodexAppServerThreadBinding;
          if (mutation.kind === "set") {
            binding = validateBindingForWrite(mutation.binding);
          } else {
            binding = validateBindingForWrite({
              ...active!.binding,
              ...mutation.patch,
              threadId: mutation.threadId,
            });
          }
          return {
            result: true,
            next: {
              version: 1,
              state: "active",
              binding,
              ...storedSessionGeneration(identity, current),
              ...ownedLease,
            },
          };
        },
        // Plain clears may expire immediately: a stale generation that re-sets
        // the key afterwards is fenced by ownsStoredSessionGeneration on read
        // and displaced via reclaim-generation; durable stable-key fences come
        // from retireSessionGeneration, not runtime clears.
        mutation.kind === "clear" && !retainLegacyClear && !leaseContext.getStore()?.has(key)
          ? 1
          : undefined,
      );
    },

    async adoptSessionGeneration(identity, expectedPreviousSessionId) {
      const key = bindingStoreKey(identity);
      const expectedSessionId = expectedPreviousSessionId.trim();
      const targetSessionId = identity.sessionId.trim();
      if (!expectedSessionId) {
        throw new Error("Codex session generation adoption requires the previous session id");
      }
      // Context-engine compaction rotates the physical OpenClaw session before
      // secondary native compaction. Compare both generations so a delayed hook
      // cannot move a newer binding back to its stale predecessor.
      return await transactKey(key, (current) => {
        if (current?.state !== "active") {
          return { result: "absent" as const };
        }
        if (current.sessionId === targetSessionId) {
          return { result: "current" as const };
        }
        if (current.sessionId !== expectedSessionId) {
          return { result: "conflict" as const };
        }
        return {
          result: "adopted" as const,
          next: { ...current, sessionId: targetSessionId },
        };
      });
    },

    async retireSessionGeneration(identity) {
      const key = bindingStoreKey(identity);
      return await transactKey(
        key,
        (current, leaseToken) => {
          if (!current) {
            return { result: "absent" as const };
          }
          if (!ownsStoredSessionGeneration(identity, current)) {
            return { result: "conflict" as const };
          }
          if (current.state === "cleared" && current.retired === true) {
            return { result: "applied" as const };
          }
          return {
            result: "applied" as const,
            next: {
              version: 1,
              state: "cleared",
              retired: true,
              ...storedSessionGeneration(identity, current),
              ...(current.lease && current.lease.token === leaseToken
                ? { lease: current.lease }
                : {}),
            },
          };
        },
        identity.sessionKey?.trim() ? undefined : PHYSICAL_SESSION_RETIRE_TTL_MS,
      );
    },

    async withLease(identity, run) {
      const key = bindingStoreKey(identity);
      const owned = leaseContext.getStore();
      const existingOwner = owned?.get(key);
      if (existingOwner) {
        const failureBeforeRun = existingOwner.failure;
        if (failureBeforeRun) {
          throw failureBeforeRun;
        }
        const result = await run();
        const failureAfterRun = existingOwner.failure;
        if (failureAfterRun) {
          throw failureAfterRun;
        }
        return result;
      }
      const token = randomUUID();
      const acquired = await transactKey(key, (current) => {
        if (
          current?.state === "cleared" &&
          current.retired === true &&
          ownsStoredSessionGeneration(identity, current)
        ) {
          return { result: false };
        }
        const lease = { token, expiresAt: Date.now() + BINDING_LEASE_STALE_MS };
        if (current?.state === "active") {
          return {
            result: true,
            next: { ...current, ...preservedSessionGeneration(identity, current), lease },
          };
        }
        if (current?.state === "cleared" && current.retired === true) {
          return { result: true, next: { ...current, lease } };
        }
        return {
          result: true,
          next: {
            version: 1,
            state: "cleared",
            ...preservedSessionGeneration(identity, current),
            lease,
          },
        };
      });
      if (!acquired) {
        throw new Error(`Codex binding generation was retired: ${key}`);
      }
      const owner: BindingLeaseOwner = { token };
      const nested = new Map(owned);
      nested.set(key, owner);
      // Long app-server RPCs can outlive the stale-owner window. Renew with an
      // exact-token CAS so live work stays serialized while a replaced owner remains fenced.
      const heartbeat = setInterval(() => renewLease(key, owner), BINDING_LEASE_RENEW_INTERVAL_MS);
      heartbeat.unref();
      try {
        const result = await leaseContext.run(nested, run);
        if (owner.failure) {
          throw owner.failure;
        }
        return result;
      } finally {
        clearInterval(heartbeat);
        try {
          const removeOwnedLease = (
            raw: unknown,
            matches: (current: StoredCodexAppServerBinding) => boolean,
          ) => {
            const current = readStoredCodexAppServerBinding(raw);
            if (!current || !matches(current) || current.lease?.token !== token) {
              return undefined;
            }
            const { lease: _lease, ...released } = current;
            return released;
          };
          const releasedActive = update(key, (raw) =>
            removeOwnedLease(raw, (current) => current.state === "active"),
          );
          if (!releasedActive) {
            const releasedRetired = update(
              key,
              (raw) =>
                removeOwnedLease(
                  raw,
                  (current) => current.state === "cleared" && current.retired === true,
                ),
              key.startsWith("session:") ? { ttlMs: PHYSICAL_SESSION_RETIRE_TTL_MS } : undefined,
            );
            if (!releasedRetired) {
              update(
                key,
                (raw) => removeOwnedLease(raw, (current) => current.state === "cleared"),
                { ttlMs: 1 },
              );
            }
          }
        } catch (error) {
          // The bounded lease expires after a crashed or disconnected owner.
          embeddedAgentLog.warn("failed to release codex app-server binding lease", {
            key,
            error,
          });
        }
      }
    },
  };
}

/** Stable plugin-state key for one current binding owner. */
export function bindingStoreKey(identity: CodexAppServerBindingIdentity): string {
  if (identity.kind === "session") {
    const rawAgentId = identity.agentId.trim();
    const sessionId = identity.sessionId.trim();
    if (!rawAgentId) {
      throw new Error("Codex app-server binding requires an agent id");
    }
    if (!sessionId) {
      throw new Error("Codex app-server binding requires a session id");
    }
    const agentId = resolveSessionAgentIds({ agentId: rawAgentId }).sessionAgentId;
    const sessionKey = identity.sessionKey?.trim();
    if (sessionKey) {
      const digest = createHash("sha256").update(sessionKey).digest("base64url");
      return `session-key:${agentId}:${digest}`;
    }
    return `session:${agentId}:${sessionId}`;
  }
  const bindingId = identity.bindingId.trim();
  if (!bindingId) {
    throw new Error("Codex app-server conversation binding requires a binding id");
  }
  return `conversation:${bindingId}`;
}

export function readStoredCodexAppServerBinding(
  value: unknown,
): StoredCodexAppServerBinding | undefined {
  const result = storedBindingSchema.safeParse(value);
  return result.success
    ? (stripUndefinedValue(result.data) as StoredCodexAppServerBinding)
    : undefined;
}

function storedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): { sessionId?: string } {
  if (identity.kind === "session") {
    return { sessionId: identity.sessionId };
  }
  return current?.sessionId ? { sessionId: current.sessionId } : {};
}

function preservedSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): { sessionId?: string } {
  if (current?.sessionId) {
    return { sessionId: current.sessionId };
  }
  return storedSessionGeneration(identity, current);
}

function ownsStoredSessionGeneration(
  identity: CodexAppServerBindingIdentity,
  current: StoredCodexAppServerBinding | undefined,
): boolean {
  return (
    identity.kind !== "session" || !current?.sessionId || current.sessionId === identity.sessionId
  );
}

function validateBindingForWrite(
  binding: CodexAppServerThreadBinding,
): CodexAppServerThreadBinding {
  const validated = readCodexAppServerThreadBinding(binding);
  if (!validated) {
    throw new Error("Invalid Codex app-server thread binding");
  }
  return stripUndefinedBinding(validated);
}

/** Parses stored or shipped sidecar data into the current domain value. */
export function readCodexAppServerThreadBinding(
  value: unknown,
): CodexAppServerThreadBinding | undefined {
  const result = threadBindingSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }
  return result.data;
}

function stripUndefinedBinding(binding: CodexAppServerThreadBinding): CodexAppServerThreadBinding {
  return stripUndefinedValue(binding) as CodexAppServerThreadBinding;
}

function stripUndefinedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedValue(entry)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  return optionalTimestampSchema.parse(value);
}

function readPluginAppPolicyContext(
  value: unknown,
  bindingSchemaVersion: 1 | 2,
): PluginAppPolicyContext | undefined {
  const record = asRecord(value);
  if (!record || typeof record.fingerprint !== "string") {
    return undefined;
  }
  const apps = asRecord(record.apps);
  if (!apps) {
    return undefined;
  }
  const parsedApps: PluginAppPolicyContext["apps"] = {};
  for (const [appId, rawEntry] of Object.entries(apps)) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      return undefined;
    }
    const destructiveApprovalMode = readDestructiveApprovalMode(
      entry.destructiveApprovalMode,
      bindingSchemaVersion,
    );
    const mcpServerNamesValid =
      Array.isArray(entry.mcpServerNames) &&
      entry.mcpServerNames.every((serverName) => typeof serverName === "string");
    if (entry.source === "account") {
      if (
        "appId" in entry ||
        typeof entry.appName !== "string" ||
        typeof entry.allowDestructiveActions !== "boolean" ||
        destructiveApprovalMode === "invalid" ||
        !mcpServerNamesValid
      ) {
        return undefined;
      }
      parsedApps[appId] = {
        source: "account",
        appName: entry.appName,
        allowDestructiveActions: entry.allowDestructiveActions,
        ...(destructiveApprovalMode ? { destructiveApprovalMode } : {}),
        mcpServerNames: entry.mcpServerNames as string[],
      };
      continue;
    }
    if (
      "appId" in entry ||
      (entry.source !== undefined && entry.source !== "plugin") ||
      typeof entry.configKey !== "string" ||
      entry.marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
      typeof entry.pluginName !== "string" ||
      typeof entry.allowDestructiveActions !== "boolean" ||
      destructiveApprovalMode === "invalid" ||
      !mcpServerNamesValid
    ) {
      return undefined;
    }
    parsedApps[appId] = {
      configKey: entry.configKey,
      marketplaceName: entry.marketplaceName,
      pluginName: entry.pluginName,
      allowDestructiveActions: entry.allowDestructiveActions,
      ...(destructiveApprovalMode ? { destructiveApprovalMode } : {}),
      mcpServerNames: entry.mcpServerNames as string[],
    };
  }
  const parsedPluginAppIds: PluginAppPolicyContext["pluginAppIds"] = {};
  if (
    record.pluginAppIds !== undefined &&
    (!record.pluginAppIds ||
      typeof record.pluginAppIds !== "object" ||
      Array.isArray(record.pluginAppIds))
  ) {
    return undefined;
  }
  if (record.pluginAppIds && typeof record.pluginAppIds === "object") {
    for (const [configKey, appIds] of Object.entries(record.pluginAppIds)) {
      if (!Array.isArray(appIds) || appIds.some((appId) => typeof appId !== "string")) {
        return undefined;
      }
      parsedPluginAppIds[configKey] = appIds;
    }
  }
  return {
    fingerprint: record.fingerprint,
    apps: parsedApps,
    pluginAppIds: parsedPluginAppIds,
  };
}

function readDestructiveApprovalMode(
  value: unknown,
  bindingSchemaVersion: 1 | 2,
): PluginAppPolicyContext["apps"][string]["destructiveApprovalMode"] | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  if (value === "allow" || value === "deny") {
    return value;
  }
  if (value === "auto") {
    return bindingSchemaVersion === 1 ? "allow" : "auto";
  }
  if (value === "ask" && bindingSchemaVersion === 2) {
    return "ask";
  }
  if (value === "on-request" && bindingSchemaVersion === 1) {
    return "auto";
  }
  return "invalid";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Returns true when an auth profile uses native Codex/OpenAI app-server auth. */
export function isCodexAppServerNativeAuthProfile(
  lookup: CodexAppServerAuthProfileLookup,
): boolean {
  const authProfileId = lookup.authProfileId?.trim();
  if (!authProfileId) {
    return false;
  }
  try {
    const store =
      lookup.authProfileStore ??
      ensureAuthProfileStore(
        lookup.agentDir?.trim() || resolveDefaultAgentDir(lookup.config ?? {}),
        {
          allowKeychainPrompt: false,
          config: lookup.config,
          externalCliProviderIds: [CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER],
          externalCliProfileIds: [authProfileId],
        },
      );
    const credential = store.profiles[authProfileId];
    if (!credential || credential.type === "api_key") {
      return false;
    }
    const provider = credential.provider?.trim();
    return Boolean(
      provider &&
      resolveProviderIdForAuth(provider, { config: lookup.config }) ===
        CODEX_APP_SERVER_NATIVE_AUTH_PROVIDER,
    );
  } catch (error) {
    embeddedAgentLog.debug("failed to resolve codex app-server auth profile provider", {
      authProfileId,
      error,
    });
    return false;
  }
}

/** Hides redundant OpenAI provider attribution for native Codex auth bindings. */
export function normalizeCodexAppServerBindingModelProvider(params: {
  authProfileId?: string;
  modelProvider?: string;
  authProfileStore?: AuthProfileStore;
  agentDir?: string;
  config?: ProviderAuthAliasConfig;
}): string | undefined {
  const modelProvider = params.modelProvider?.trim();
  if (!modelProvider) {
    return undefined;
  }
  if (
    isCodexAppServerNativeAuthProfile(params) &&
    modelProvider.toLowerCase() === PUBLIC_OPENAI_MODEL_PROVIDER
  ) {
    return undefined;
  }
  return modelProvider;
}

/** Restores the sole provider intentionally omitted from canonical binding rows. */
export function resolveCodexAppServerBindingModelProvider(
  params: CodexAppServerAuthProfileLookup & { modelProvider?: string },
): string | undefined {
  return (
    params.modelProvider?.trim() ||
    (isCodexAppServerNativeAuthProfile(params) ? PUBLIC_OPENAI_MODEL_PROVIDER : undefined)
  );
}
