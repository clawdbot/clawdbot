import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  readAcpSessionMeta,
  readAcpSessionMetaForEntry,
  repairAcpSessionMetaKeyForMigration,
} from "../acp/runtime/session-meta.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveAgentAvatarUrlFromSource } from "../agents/identity-avatar-file.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "../agents/session-permission-exec-mode.js";
import { insideGitCheckout } from "../agents/worktrees/git.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import {
  resolveAgentMainSessionKey,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import type { SessionEntryListScope } from "../config/sessions/session-accessor.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecPolicyForMode } from "../infra/exec-approvals-core.js";
import { loadExecApprovals } from "../infra/exec-approvals-store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { listAgentProvenance } from "../state/agent-provenance.js";
import { listGatewayAgentsBasic } from "./agent-list.js";
import type { GatewayAgentOwnership } from "./agent-list.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { resolveGatewayModelThinkingProfile } from "./session-utils-model.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";
import type { GatewayAgentRow, SessionListModelCatalog } from "./session-utils.types.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

/**
 * Returns the owning agent id if the session key belongs to an agent that is no
 * longer present in config (deleted). Returns null for non-agent legacy/global
 * keys, confirmed ACP runtime session keys, or when the owning agent still
 * exists (#65524).
 */
export function resolveDeletedAgentIdFromSessionKey(
  cfg: OpenClawConfig,
  sessionKey: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const agentId = normalizeAgentId(parsed.agentId);
  if (listAgentIds(cfg).includes(agentId)) {
    return null;
  }
  if (isAcpSessionKey(sessionKey) && !parsed.rest.startsWith("acp:binding:")) {
    // Free ACP runtime keys use agent:<harnessId>:acp:<uuid>, but key shape is
    // not proof: ACP bridge sessions can use ACP-shaped keys without SessionAcpMeta.
    // Configured acp:binding keys stay owner-scoped even when ACP metadata exists.
    const acpMeta = readAcpMetaForDeletedAgentCheck({
      cfg,
      sessionKey,
      entry,
      acpMetadataSessionKey: options?.acpMetadataSessionKey,
    });
    if (acpMeta) {
      return null;
    }
  }
  return agentId;
}

function readAcpMetaForDeletedAgentCheck(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: Pick<SessionEntry, "acp" | "lifecycleRevision"> | null;
  acpMetadataSessionKey?: string | null;
}) {
  if (params.entry?.acp) {
    return params.entry.acp;
  }

  const acpMetadataSessionKey = normalizeOptionalString(params.acpMetadataSessionKey);
  const directKeys = new Set<string>();
  if (acpMetadataSessionKey) {
    directKeys.add(acpMetadataSessionKey);
  } else {
    const acpMeta = readAcpSessionMeta({ sessionKey: params.sessionKey, cfg: params.cfg });
    if (acpMeta) {
      return acpMeta;
    }
  }
  directKeys.add(params.sessionKey);

  for (const directKey of directKeys) {
    const agentId =
      parseAgentSessionKey(directKey)?.agentId ??
      tryResolveSessionCompatibilityOwnerAgentId(params.cfg, directKey);
    const acpMeta = readAcpSessionMetaForEntry({
      sessionKey: directKey,
      ...(agentId ? { agentId } : {}),
      entry: params.entry ?? undefined,
    });
    if (acpMeta) {
      return acpMeta;
    }
  }

  repairAcpSessionMetaKeyForMigration({
    sessionKey: params.sessionKey,
    candidateSessionKeys: directKeys,
    entry: params.entry ?? undefined,
  });
  const finalAgentId =
    parseAgentSessionKey(params.sessionKey)?.agentId ??
    tryResolveSessionCompatibilityOwnerAgentId(params.cfg, params.sessionKey);
  return readAcpSessionMetaForEntry({
    sessionKey: params.sessionKey,
    ...(finalAgentId ? { agentId: finalAgentId } : {}),
    entry: params.entry ?? undefined,
  });
}

function loadSessionEntryWithMode(
  sessionKey: string,
  opts:
    | (Pick<SessionEntryListScope, "agentId" | "clone" | "projection"> & {
        includeStoreChildEntries?: boolean;
      })
    | undefined,
  readOnly: boolean,
) {
  const cfg = getRuntimeConfig();
  const key = normalizeOptionalString(sessionKey) ?? "";
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key,
    exactRead: true,
    readOnly,
    projection: opts?.projection,
    ...(opts?.clone === false ? { clone: false } : {}),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    ...(opts?.includeStoreChildEntries ? { includeStoreChildEntries: true } : {}),
  });
  const storePath = target.storePath;
  const store = target.store;
  if (!readOnly) {
    for (const storeKey of target.storeKeys) {
      if (isInternalSessionEffectsKey(storeKey)) {
        delete store[storeKey];
      }
    }
  }
  const canonicalMatch = resolveCanonicalSessionStoreMatchFromStoreKeys(store, target.storeKeys);
  const legacyKey = canonicalMatch?.key !== target.canonicalKey ? canonicalMatch?.key : undefined;
  const entry =
    readOnly && opts?.clone !== false && canonicalMatch?.entry
      ? structuredClone(canonicalMatch.entry)
      : canonicalMatch?.entry;
  return {
    cfg,
    agentId: target.agentId,
    storePath,
    store,
    entry,
    canonicalKey: target.canonicalKey,
    storeKeys: target.storeKeys,
    legacyKey,
  };
}

export function loadGatewaySessionEntry(
  sessionKey: string,
  opts?: Pick<SessionEntryListScope, "agentId" | "clone" | "projection">,
) {
  return loadSessionEntryWithMode(sessionKey, opts, false);
}

export function loadGatewaySessionEntryReadOnly(
  sessionKey: string,
  opts?: { agentId?: string; clone?: boolean; includeStoreChildEntries?: boolean },
) {
  return loadSessionEntryWithMode(sessionKey, opts, true);
}

/** Returns the one canonical entry and the exact persisted key that owns it. */
export function resolveCanonicalSessionStoreMatchFromStoreKeys<TEntry extends SessionEntry>(
  store: Record<string, TEntry>,
  storeKeys: string[],
): { key: string; entry: TEntry } | undefined {
  let selected: { key: string; entry: TEntry } | undefined;
  for (const key of storeKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    const match = { key, entry };
    if (selected) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${storeKeys[0] ?? key}`,
      );
    }
    selected = match;
  }
  if (selected && selected.key !== storeKeys[0]) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${storeKeys[0] ?? selected.key}`,
    );
  }
  return selected;
}

export function resolveCanonicalSessionEntryFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): SessionEntry | undefined {
  return resolveCanonicalSessionStoreMatchFromStoreKeys(store, storeKeys)?.entry;
}

export function resolveCanonicalGatewaySessionStoreKey(params: {
  cfg: OpenClawConfig;
  key: string;
  store: Record<string, SessionEntry>;
  agentId?: string;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const primaryKey = target.canonicalKey;
  resolveCanonicalSessionStoreMatchFromStoreKeys(params.store, target.storeKeys);
  return { target, primaryKey, entry: params.store[primaryKey] };
}

export function parseGroupKey(
  key: string,
): { channel?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [channel, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { channel, kind, id };
    }
  }
  return null;
}

export function isGroupOrChannelDisplaySession(
  entry: SessionEntry | undefined,
  parsed: { kind?: "group" | "channel" } | null,
): boolean {
  return (
    entry?.chatType === "group" ||
    entry?.chatType === "channel" ||
    parsed?.kind === "group" ||
    parsed?.kind === "channel"
  );
}

function normalizeFallbackList(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function resolveGatewayAgentModel(
  cfg: OpenClawConfig,
  agentId: string,
  resolvedModel: ReturnType<typeof resolveDefaultModelForAgent>,
): NonNullable<GatewayAgentRow["model"]> {
  // Agent rows expose model identity to clients; credential-profile binding stays in
  // canonical config and is consumed only by execution-time model selection.
  const primary = `${resolvedModel.provider}/${resolvedModel.model}`;
  const fallbackOverride = resolveAgentModelFallbacksOverride(cfg, agentId);
  const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const fallbacks = normalizeFallbackList(
    (fallbackOverride ?? defaultFallbacks).map((value) => splitTrailingAuthProfile(value).model),
  );
  return {
    primary,
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

function resolvedPermissionLabel(
  policy: Pick<ReturnType<typeof resolveExecDefaults>, "mode" | "security" | "ask">,
): GatewayAgentRow["defaultPermissionMode"] {
  const { mode } = policy;
  const canonical = resolveExecPolicyForMode(mode);
  // Display resolved posture, never authorization. Allowlist has no matching
  // session mode; lossy security/ask pairs must also remain unlabeled.
  return mode !== "allowlist" &&
    policy.security === canonical.security &&
    policy.ask === canonical.ask
    ? SESSION_PERMISSION_BY_EXEC_MODE[mode]
    : undefined;
}

export function listAgentsForGateway(
  cfg: OpenClawConfig,
  modelCatalog?: ModelCatalogEntry[],
  options?: {
    modelCatalogByAgentId?: SessionListModelCatalog;
    includeSystem?: boolean;
  },
): {
  defaultId: string;
  ownership: GatewayAgentOwnership;
  selectionRequired: boolean;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const basic = listGatewayAgentsBasic(cfg);
  const execApprovals = loadExecApprovals();
  const identityById = new Map<string, GatewayAgentRow["identity"]>();
  for (const entry of listAgentEntries(cfg)) {
    if (!entry?.id) {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    const avatar = normalizeOptionalString(entry.identity?.avatar);
    const avatarUrl = resolveAgentAvatarUrlFromSource(cfg, agentId, avatar);
    const identity = entry.identity
      ? {
          name: normalizeOptionalString(entry.identity.name),
          theme: normalizeOptionalString(entry.identity.theme),
          emoji: normalizeOptionalString(entry.identity.emoji),
          avatar,
          avatarUrl,
        }
      : undefined;
    identityById.set(agentId, identity);
  }
  const roster = options?.includeSystem
    ? basic.agents
    : basic.agents.filter((entry) => entry.kind !== "system");
  const provenanceById = new Map(
    listAgentProvenance().map((record) => [record.agentId, record] as const),
  );
  const agents = roster.map((entry) => {
    const { id } = entry;
    const execDefaults = resolveExecDefaults({ cfg, agentId: id, execApprovals });
    // This label must never overstate permissiveness. When sandbox policy can vary
    // by session, the effective policy is unknowable at agent scope: omit the label.
    const defaultPermissionMode =
      resolveSandboxConfigForAgent(cfg, id).mode === "off"
        ? resolvedPermissionLabel(execDefaults)
        : undefined;
    const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
    const model = resolveGatewayAgentModel(cfg, id, resolvedModel);
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: id });
    const agentRuntime = projectWorkerPlacementAgentRuntime(
      resolveModelAgentRuntimeMetadata({
        cfg,
        agentId: id,
        provider: resolvedModel.provider,
        model: resolvedModel.model,
        sessionKey,
        acpRuntime: false,
      }),
    );
    const hasAgentCatalog = options?.modelCatalogByAgentId?.has(id);
    // Unconfigured system rows inherit the default catalog; keep its provider
    // policy attached. A configured owner with no catalog must not inherit it.
    const preparedCatalog = hasAgentCatalog
      ? options?.modelCatalogByAgentId?.get(id)
      : modelCatalog
        ? undefined
        : options?.modelCatalogByAgentId?.get(basic.defaultId);
    const agentModelCatalog = hasAgentCatalog
      ? preparedCatalog?.entries
      : (modelCatalog ?? preparedCatalog?.entries);
    const thinkingProfile = resolveGatewayModelThinkingProfile({
      cfg,
      agentId: id,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      modelCatalog: agentModelCatalog,
      sessionKey,
      providerPolicySource: preparedCatalog?.pluginRegistry,
    });
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    // Must mirror the sessions.create worktree preflight: subdirectory workspaces inside a
    // repo are worktree-capable, so the UI toggle and the create path cannot diverge.
    const workspaceGit = insideGitCheckout(workspace);
    const agent = Object.assign(
      {
        id,
        ...(options?.includeSystem ? { kind: entry.kind } : {}),
        name: entry.name,
        identity: identityById.get(id),
        workspace,
        workspaceGit,
        agentRuntime,
        // Preserve the established serialized projection order for byte-stable responses.
        thinkingLevels: thinkingProfile.thinkingLevels,
        thinkingOptions: thinkingProfile.thinkingLevels.map((level) => level.label),
        thinkingDefault: thinkingProfile.thinkingDefault,
      },
      { model },
      defaultPermissionMode ? { defaultPermissionMode } : {},
    );
    const provenance = provenanceById.get(id);
    return provenance
      ? Object.assign(agent, {
          createdVia: provenance.createdVia,
          creatorAgentId: provenance.creatorAgentId,
          createdAt: provenance.createdAtMs,
        })
      : agent;
  });
  return {
    defaultId: basic.defaultId,
    ownership: basic.ownership!,
    selectionRequired: basic.selectionRequired!,
    mainKey: basic.mainKey,
    scope: basic.scope,
    agents,
  };
}
