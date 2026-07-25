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
  listAgentIds,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { resolveAgentAvatarUrlFromSource } from "../agents/identity-avatar-file.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { insideGitCheckout } from "../agents/worktrees/git.js";
import { listThinkingLevelOptions } from "../auto-reply/thinking.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import {
  resolveAgentMainSessionKey,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { listGatewayAgentsBasic } from "./agent-list.js";
import { resolveGatewaySessionThinkingDefault } from "./session-utils-model.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils-store-lookup.js";
import type { GatewayAgentRow, GatewaySessionRow } from "./session-utils.types.js";

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
    const acpMeta = readAcpSessionMetaForEntry({
      sessionKey: directKey,
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
  return readAcpSessionMetaForEntry({
    sessionKey: params.sessionKey,
    entry: params.entry ?? undefined,
  });
}

function loadSessionEntryWithMode(
  sessionKey: string,
  opts: { agentId?: string; clone?: boolean } | undefined,
  readOnly: boolean,
) {
  const cfg = getRuntimeConfig();
  const key = normalizeOptionalString(sessionKey) ?? "";
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key,
    ...(opts?.clone === false ? { clone: false } : {}),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    ...(readOnly ? { readOnly: true } : {}),
  });
  const storePath = target.storePath;
  const store = target.store;
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(store, target.storeKeys);
  const legacyKey = freshestMatch?.key !== target.canonicalKey ? freshestMatch?.key : undefined;
  return {
    cfg,
    storePath,
    store,
    entry: freshestMatch?.entry,
    canonicalKey: target.canonicalKey,
    storeKeys: target.storeKeys,
    legacyKey,
  };
}

export function loadSessionEntry(sessionKey: string, opts?: { agentId?: string; clone?: boolean }) {
  return loadSessionEntryWithMode(sessionKey, opts, false);
}

export function loadSessionEntryReadOnly(
  sessionKey: string,
  opts?: { agentId?: string; clone?: boolean },
) {
  return loadSessionEntryWithMode(sessionKey, opts, true);
}

/** Returns both the freshest entry and the exact persisted key that owns it. */
export function resolveFreshestSessionStoreMatchFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of storeKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    const match = { key, entry };
    if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

export function resolveFreshestSessionEntryFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): SessionEntry | undefined {
  return resolveFreshestSessionStoreMatchFromStoreKeys(store, storeKeys)?.entry;
}

/**
 * Remove legacy key variants for one canonical session key.
 * Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
 */
function pruneLegacyStoreKeys(params: {
  store: Record<string, unknown>;
  canonicalKey: string;
  candidates: Iterable<string>;
}) {
  const keysToDelete = new Set<string>();
  for (const candidate of params.candidates) {
    const trimmed = normalizeOptionalString(candidate ?? "") ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed !== params.canonicalKey) {
      keysToDelete.add(trimmed);
    }
  }
  for (const key of keysToDelete) {
    delete params.store[key];
  }
}

export function migrateAndPruneGatewaySessionStoreKey(params: {
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
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(
    params.store,
    target.storeKeys,
  );
  if (freshestMatch) {
    const currentPrimary = params.store[primaryKey];
    if (!currentPrimary || (freshestMatch.entry.updatedAt ?? 0) > (currentPrimary.updatedAt ?? 0)) {
      params.store[primaryKey] = freshestMatch.entry;
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

export function classifySessionKey(key: string, entry?: SessionEntry): GatewaySessionRow["kind"] {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
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

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

export function resolveConcreteSessionStorePath(storePath: string | undefined): string | undefined {
  const trimmed = storePath?.trim();
  if (!trimmed || trimmed === "(multiple)" || isStorePathTemplate(trimmed)) {
    return undefined;
  }
  return trimmed;
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
): GatewayAgentRow["model"] | undefined {
  const primary = resolveAgentEffectiveModelPrimary(cfg, agentId)?.trim();
  const fallbackOverride = resolveAgentModelFallbacksOverride(cfg, agentId);
  const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const fallbacks = normalizeFallbackList(fallbackOverride ?? defaultFallbacks);
  if (!primary && fallbacks.length === 0) {
    return undefined;
  }
  return {
    ...(primary ? { primary } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

export function listAgentsForGateway(
  cfg: OpenClawConfig,
  modelCatalog?: ModelCatalogEntry[],
  options?: {
    modelCatalogByAgentId?: ReadonlyMap<string, ModelCatalogEntry[]>;
    includeSystem?: boolean;
  },
): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const basic = listGatewayAgentsBasic(cfg);
  const configuredById = new Map<string, { identity?: GatewayAgentRow["identity"] }>();
  for (const entry of cfg.agents?.list ?? []) {
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
    configuredById.set(agentId, { identity });
  }
  const roster = options?.includeSystem
    ? basic.agents
    : basic.agents.filter((entry) => entry.kind !== "system");
  const agents = roster.map((entry) => {
    const { id } = entry;
    const meta = configuredById.get(id);
    const model = resolveGatewayAgentModel(cfg, id);
    const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: id });
    const agentRuntime = resolveModelAgentRuntimeMetadata({
      cfg,
      agentId: id,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      sessionKey,
      acpRuntime: false,
    });
    const thinkingRuntime = resolveEffectiveAgentRuntime({
      cfg,
      provider: resolvedModel.provider,
      modelId: resolvedModel.model,
      agentId: id,
      sessionKey,
    });
    const agentModelCatalog = options?.modelCatalogByAgentId?.get(id) ?? modelCatalog;
    const thinkingLevels = listThinkingLevelOptions(
      resolvedModel.provider,
      resolvedModel.model,
      agentModelCatalog,
      thinkingRuntime,
    );
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    // Must mirror the sessions.create worktree preflight: subdirectory workspaces inside a
    // repo are worktree-capable, so the UI toggle and the create path cannot diverge.
    const workspaceGit = insideGitCheckout(workspace);
    return Object.assign(
      {
        id,
        ...(options?.includeSystem ? { kind: entry.kind } : {}),
        name: entry.name,
        identity: meta?.identity,
        workspace,
        workspaceGit,
        agentRuntime,
        thinkingLevels,
        thinkingOptions: thinkingLevels.map((level) => level.label),
        thinkingDefault: resolveGatewaySessionThinkingDefault({
          cfg,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          agentId: id,
          modelCatalog: agentModelCatalog,
          agentRuntime: thinkingRuntime,
        }),
      },
      model ? { model } : {},
    );
  });
  return { defaultId: basic.defaultId, mainKey: basic.mainKey, scope: basic.scope, agents };
}
