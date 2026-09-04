import crypto from "node:crypto";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import type { DelegationCapability } from "../agents/delegation-capability.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "../agents/exec-defaults.js";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import type { CapturedSessionPlacementComputer } from "../agents/session-placement-computer.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import type { ExecMode } from "../infra/exec-approvals.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";

export type McpLoopbackRequestContext = {
  sessionKey: string;
  runtimePolicySessionKey?: string;
  /** Agent whose execution policy applies when it differs from the durable session owner. */
  runtimePolicyAgentId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  /** Server-selected roots for mediated coding tools in this CLI run. */
  workspaceDir?: string;
  cwd?: string;
  modelProvider?: string;
  modelId?: string;
  modelHasVision?: boolean;
  messageProvider?: string;
  clientCaps?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  currentInboundAudio?: boolean;
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Immutable completion-only authority; never sourced from MCP request headers. */
  sourceReplyOnly?: boolean;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  /**
   * Per-run allowlist of gateway tool names for this grant. When set, the
   * loopback surface lists and executes only these tools; CLI-side flags such
   * as `--allowedTools` are advisory under bypass permission modes, so the
   * grant is where restricted one-shot runs (e.g. active-memory recall) get
   * hard enforcement. Unset keeps the full session-scoped surface.
   */
  toolsAllow?: string[];
  skillWorkshop?: Pick<SkillWorkshopRunOptions, "proposalRevision">;
  /**
   * Attempt-local authority to start or redirect delegated work, stamped into
   * the grant so a fallback completion-report turn running on a CLI backend
   * gets the same gate as an embedded attempt. The loopback surface enforces
   * it on both tools/list and tools/call, so CLI-side advisory flags cannot
   * reopen it. Unset keeps the full delegation surface.
   */
  delegationCapability?: DelegationCapability;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  /** Host-owned creator origin; child MCP request fields cannot widen it. */
  cronCreatorCallerOrigin?: CronScheduledToolCallerOrigin;
  senderIsOwner: boolean;
  /** Capability minted only for Gateway-launched CLI backends. */
  nodeExecAllowed?: boolean;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides & { mode?: ExecMode };
  bashElevated?: ExecElevatedDefaults;
  trigger?: string;
  approvalReviewerDeviceId?: string;
  channelContext?: PluginHookChannelContext;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
};

interface McpAttachGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** The openclaw session this grant is bound to; tool scope is resolved for this key. */
  readonly sessionKey: string;
  /** Explicit agent owner for canonical global sessions, whose key cannot encode one. */
  readonly agentId?: string;
  /** Absolute expiry (ms epoch). */
  readonly expiresAtMs: number;
  /** Absolute mint time (ms epoch). */
  readonly issuedAtMs: number;
}

interface McpLoopbackClientGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Gateway-selected request context; child-process headers cannot widen it. */
  readonly context: McpLoopbackRequestContext;
}

type McpLoopbackToolAuth = {
  agentDir?: string;
  store: AuthProfileStore;
};

type StoredMcpLoopbackClientGrant = McpLoopbackClientGrant & {
  owner: McpLoopbackClientGrant;
  state: "active" | "retired";
  runtimeOwnerToken: string;
  /** Exact host admission retained outside the child-visible request context. */
  admittedRunContext?: AdmittedRunContext;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
  activeCapture?: McpLoopbackClientCapture;
  computerOwner?: CapturedSessionPlacementComputer | null;
  predecessorCleanup?: Promise<void>;
  toolAuth?: McpLoopbackToolAuth;
};

/** Private attempt owner; a reused bearer or capture string never revives this object. */
export type McpLoopbackClientCapture = Readonly<{
  key: string;
  signal: AbortSignal;
  ready: Promise<void>;
  registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
  createComputerTransport: () => ReturnType<CapturedSessionPlacementComputer["bind"]> | undefined;
  close: (reason: string) => Promise<void>;
}>;

const runtimeCaptures = resolveGlobalMap<string, Set<McpLoopbackClientCapture>>(
  Symbol.for("openclaw.mcpLoopbackRuntimeCaptures"),
  async (captures) => {
    await drainMcpCaptureCleanup([...captures.keys()].map(revokeMcpLoopbackClientGrantsForRuntime));
  },
);

async function drainMcpCaptureCleanup(work: Iterable<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(new Set(work));
  const failures = [
    ...new Set(results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))),
  ];
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "MCP tool cleanup failed");
  }
}

function closeGrantCaptures(
  grants: Array<StoredMcpLoopbackClientGrant | undefined>,
): Promise<void> {
  const pending = drainMcpCaptureCleanup(
    grants.flatMap((grant) => [
      ...(grant?.predecessorCleanup ? [grant.predecessorCleanup] : []),
      ...(grant?.activeCapture ? [grant.activeCapture.close("grant-retired")] : []),
    ]),
  );
  // Synchronous transfer retains this promise for the successor's ready/close
  // joins; an early rejection must not escape before either owner can await it.
  void pending.catch(() => {});
  return pending;
}

function createMcpClientCapture(
  grant: StoredMcpLoopbackClientGrant,
  key: string,
  inputSignal?: AbortSignal,
): McpLoopbackClientCapture {
  const controller = new AbortController();
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const ready = closeGrantCaptures([grant]);
  let closing: Promise<void> | undefined;
  let stopAuthorityObserver: (() => void) | undefined;
  const captures = runtimeCaptures.get(grant.runtimeOwnerToken) ?? new Set();
  runtimeCaptures.set(grant.runtimeOwnerToken, captures);
  const onAbort = () => {
    void capture.close("cancel");
  };
  const capture: McpLoopbackClientCapture = Object.freeze({
    key,
    signal: controller.signal,
    ready,
    registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => {
      controller.signal.throwIfAborted();
      cleanups.push(cleanup);
    },
    createComputerTransport: () => {
      controller.signal.throwIfAborted();
      if (!grant.computerOwner) {
        return grant.computerOwner;
      }
      return grant.admittedRunContext
        ? grant.computerOwner.bind(grant.admittedRunContext.operationalRunInstance)
        : null;
    },
    close: (reason: string) => {
      if (closing) {
        return closing;
      }
      // Fence before any await; retained callbacks and dispatched requests observe
      // cancellation while the CLI still retains outcome observers and its queue slot.
      const callbacks = cleanups.splice(0);
      closing = Promise.resolve().then(() =>
        drainMcpCaptureCleanup([ready, ...callbacks.map(async (cleanup) => await cleanup(reason))]),
      );
      controller.abort();
      stopAuthorityObserver?.();
      inputSignal?.removeEventListener("abort", onAbort);
      // Failed closes stay runtime-owned until shutdown joins them. The original
      // rejecting promise is also returned to every attempt/revocation waiter.
      void closing.then(
        () => {
          captures.delete(capture);
          if (captures.size === 0 && runtimeCaptures.get(grant.runtimeOwnerToken) === captures) {
            runtimeCaptures.delete(grant.runtimeOwnerToken);
          }
        },
        () => {},
      );
      return closing;
    },
  });
  captures.add(capture);
  // Readiness failures remain observable by request admission and close(), even
  // when a synchronous transfer precedes the next request or runtime shutdown.
  void ready.catch(() => {});
  const authority =
    grant.admittedRunContext && getAdmittedRunDelegatedAuthority(grant.admittedRunContext);
  if (authority) {
    stopAuthorityObserver = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
      if (closed === authority) {
        void capture.close("authority-closed");
      }
    });
  }
  if (inputSignal?.aborted) {
    onAbort();
  } else {
    inputSignal?.addEventListener("abort", onAbort, { once: true });
  }
  return capture;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_TTL_MS = 12 * 60 * 60 * 1000;

const grantsByToken = resolveGlobalMap<string, McpAttachGrant>(
  Symbol.for("openclaw.mcpAttachGrants"),
  "close-and-restart",
);
const clientGrantsByToken = resolveGlobalMap<string, StoredMcpLoopbackClientGrant>(
  Symbol.for("openclaw.mcpLoopbackClientGrants"),
  "close-and-restart",
);

function clampTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(ttlMs as number, MAX_TTL_MS);
}

export function mintAttachGrant(params: {
  sessionKey: string;
  agentId?: string;
  ttlMs?: number;
  nowMs?: number;
}): McpAttachGrant {
  const sessionKey = params.sessionKey?.trim() ?? "";
  if (!sessionKey) {
    throw new Error("mintAttachGrant: sessionKey is required");
  }
  const agentId = sessionKey === "global" ? params.agentId?.trim() || undefined : undefined;
  const nowMs = params.nowMs ?? Date.now();
  // Mint sweeps stale entries so abandoned grants do not accumulate.
  sweepExpiredAttachGrants(nowMs);
  const grant: McpAttachGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    sessionKey,
    ...(agentId ? { agentId } : {}),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + clampTtlMs(params.ttlMs),
  };
  grantsByToken.set(grant.token, grant);
  return grant;
}

export function resolveAttachGrant(
  token: string,
  nowMs: number = Date.now(),
): McpAttachGrant | undefined {
  const grant = grantsByToken.get(token);
  if (!grant) {
    return undefined;
  }
  if (nowMs >= grant.expiresAtMs) {
    grantsByToken.delete(token);
    return undefined;
  }
  return grant;
}

export function revokeAttachGrant(token: string): boolean {
  return grantsByToken.delete(token);
}

/** Revokes every attach grant minted for one session. Returns the count removed. */
export function revokeAttachGrantsForSession(sessionKey: string): number {
  const key = sessionKey.trim();
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (grant.sessionKey === key) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

function sweepExpiredAttachGrants(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (nowMs >= grant.expiresAtMs) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function mintMcpLoopbackClientGrant(params: {
  context: McpLoopbackRequestContext;
  runtimeOwnerToken: string;
  admittedRunContext?: AdmittedRunContext;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
  computerOwner?: CapturedSessionPlacementComputer | null;
  toolAuth?: McpLoopbackToolAuth;
}): McpLoopbackClientGrant {
  const sessionKey = params.context.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("mintMcpLoopbackClientGrant: context.sessionKey is required");
  }
  const runtimeOwnerToken = params.runtimeOwnerToken.trim();
  if (!runtimeOwnerToken) {
    throw new Error("mintMcpLoopbackClientGrant: runtimeOwnerToken is required");
  }
  const owner: McpLoopbackClientGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    context: structuredClone({ ...params.context, sessionKey }),
  };
  const grant: StoredMcpLoopbackClientGrant = {
    token: owner.token,
    context: structuredClone(owner.context),
    owner,
    state: "active",
    runtimeOwnerToken,
    ...(params.admittedRunContext ? { admittedRunContext: params.admittedRunContext } : {}),
    ...(params.skillLibraryAuthoring
      ? { skillLibraryAuthoring: params.skillLibraryAuthoring }
      : {}),
    ...(params.toolAuth ? { toolAuth: structuredClone(params.toolAuth) } : {}),
    ...(params.computerOwner !== undefined ? { computerOwner: params.computerOwner } : {}),
  };
  clientGrantsByToken.set(grant.token, grant);
  return owner;
}

/** Attaches the exact late CLI admission before the grant can execute tools. */
export function bindMcpLoopbackClientGrantAdmission(params: {
  token: string;
  expectedOwner: McpLoopbackClientGrant;
  runtimeOwnerToken: string;
  admittedRunContext: AdmittedRunContext;
}): boolean {
  const grant = clientGrantsByToken.get(params.token);
  if (
    !grant ||
    grant.state !== "active" ||
    grant.owner !== params.expectedOwner ||
    grant.runtimeOwnerToken !== params.runtimeOwnerToken ||
    (grant.admittedRunContext && grant.admittedRunContext !== params.admittedRunContext)
  ) {
    return false;
  }
  const { activeCapture: _activeCapture, ...inactiveGrant } = grant;
  clientGrantsByToken.set(params.token, {
    ...inactiveGrant,
    predecessorCleanup: closeGrantCaptures([grant]),
    admittedRunContext: params.admittedRunContext,
  });
  return true;
}

/** Bind a fresh private owner before the child starts, even when its header key repeats. */
export function activateMcpLoopbackClientGrantCapture(params: {
  token: string;
  expectedOwner: McpLoopbackClientGrant;
  runtimeOwnerToken: string;
  captureKey: string;
  signal?: AbortSignal;
}): McpLoopbackClientCapture | undefined {
  const captureKey = params.captureKey.trim();
  if (!captureKey) {
    throw new Error("activateMcpLoopbackClientGrantCapture: captureKey is required");
  }
  const grant = clientGrantsByToken.get(params.token);
  if (
    !grant ||
    grant.state !== "active" ||
    grant.owner !== params.expectedOwner ||
    grant.runtimeOwnerToken !== params.runtimeOwnerToken
  ) {
    return undefined;
  }
  const capture = createMcpClientCapture(grant, captureKey, params.signal);
  const { predecessorCleanup: _predecessorCleanup, ...currentGrant } = grant;
  clientGrantsByToken.set(params.token, { ...currentGrant, activeCapture: capture });
  return capture;
}

/** Move one prepared turn onto the bearer already held by a warm CLI child. */
export function transferMcpLoopbackClientGrant(params: {
  sourceToken: string;
  targetToken: string;
  expectedOwner: McpLoopbackClientGrant;
  runtimeOwnerToken: string;
}): boolean {
  const source = clientGrantsByToken.get(params.sourceToken);
  const target = clientGrantsByToken.get(params.targetToken);
  if (
    !source ||
    source.state !== "active" ||
    source.owner !== params.expectedOwner ||
    source.runtimeOwnerToken !== params.runtimeOwnerToken ||
    (target && target.runtimeOwnerToken !== params.runtimeOwnerToken)
  ) {
    return false;
  }
  if (params.sourceToken === params.targetToken) {
    return true;
  }
  // The child cannot replace its bearer after launch. Turn cleanup may already
  // have revoked that bearer, so recreate it only from this fresh admitted grant.
  // An existing bearer owned by another runtime is never replaceable.
  const { activeCapture: _activeCapture, ...inactiveSource } = source;
  clientGrantsByToken.set(params.targetToken, {
    ...inactiveSource,
    token: params.targetToken,
    predecessorCleanup: closeGrantCaptures([source, target]),
  });
  clientGrantsByToken.delete(params.sourceToken);
  return true;
}

export function resolveMcpLoopbackClientGrant(params: {
  token: string;
  runtimeOwnerToken: string;
  captureKey: string;
}):
  | {
      context: McpLoopbackRequestContext;
      captureKey: string;
      capture: McpLoopbackClientCapture;
      admittedRunContext: AdmittedRunContext;
      skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
      isCurrent: () => boolean;
      toolAuth?: McpLoopbackToolAuth;
    }
  | undefined {
  const { token, runtimeOwnerToken, captureKey } = params;
  const grant = clientGrantsByToken.get(token);
  const admittedRunContext = grant?.admittedRunContext;
  const delegatedAuthority =
    admittedRunContext && getAdmittedRunDelegatedAuthority(admittedRunContext);
  if (
    !grant ||
    grant.state !== "active" ||
    grant.runtimeOwnerToken !== runtimeOwnerToken ||
    !admittedRunContext ||
    !delegatedAuthority ||
    !grant.activeCapture ||
    grant.activeCapture.signal.aborted ||
    grant.activeCapture.key !== captureKey
  ) {
    return undefined;
  }
  // Cached tools and OAuth refreshes must share the prepared store for this
  // grant; cloning on each request would discard refreshed credentials.
  return {
    context: structuredClone(grant.context),
    captureKey: grant.activeCapture.key,
    capture: grant.activeCapture,
    admittedRunContext,
    ...(grant.skillLibraryAuthoring ? { skillLibraryAuthoring: grant.skillLibraryAuthoring } : {}),
    // Every bind, capture change, and transfer replaces the row, fencing even same-reference reuse.
    isCurrent: () =>
      clientGrantsByToken.get(token) === grant &&
      !grant.activeCapture?.signal.aborted &&
      getAdmittedRunDelegatedAuthority(admittedRunContext) === delegatedAuthority,
    ...(grant.toolAuth ? { toolAuth: grant.toolAuth } : {}),
  };
}

export function revokeMcpLoopbackClientGrant(
  token: string,
  expectedOwner: McpLoopbackClientGrant,
): Promise<boolean> {
  const grant = clientGrantsByToken.get(token);
  if (!grant || grant.owner !== expectedOwner) {
    return Promise.resolve(false);
  }
  const newlyRetired = grant.state === "active";
  const retired: StoredMcpLoopbackClientGrant = newlyRetired
    ? { ...grant, state: "retired" }
    : grant;
  // Keep the fenced owner discoverable during cleanup: a warm-token transfer
  // must inherit its pending drain. Late deletion must never remove a successor.
  clientGrantsByToken.set(token, retired);
  return closeGrantCaptures([grant])
    .finally(() => {
      if (clientGrantsByToken.get(token) === retired) {
        clientGrantsByToken.delete(token);
      }
    })
    .then(() => newlyRetired);
}

export function revokeMcpLoopbackClientGrantsForRuntime(runtimeOwnerToken: string): Promise<void> {
  const grants: StoredMcpLoopbackClientGrant[] = [];
  for (const [token, grant] of clientGrantsByToken) {
    if (grant.runtimeOwnerToken === runtimeOwnerToken) {
      clientGrantsByToken.delete(token);
      grants.push(grant);
    }
  }
  // Include retired/replaced owners: their grant row may be gone while its
  // cleanup is still pending or failed. Snapshot before close mutates the set.
  const captures = [...(runtimeCaptures.get(runtimeOwnerToken) ?? [])];
  return drainMcpCaptureCleanup([
    closeGrantCaptures(grants),
    ...captures.map((capture) => capture.close("runtime-shutdown")),
  ]).finally(() => {
    const remaining = runtimeCaptures.get(runtimeOwnerToken);
    for (const capture of captures) {
      remaining?.delete(capture);
    }
    if (remaining?.size === 0) {
      runtimeCaptures.delete(runtimeOwnerToken);
    }
  });
}
