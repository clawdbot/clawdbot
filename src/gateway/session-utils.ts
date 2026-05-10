import fs from "node:fs";
import path from "node:path";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { lookupContextTokens, resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  findModelCatalogEntry,
  modelSupportsInput,
  type ModelCatalogEntry,
} from "../agents/model-catalog.js";
import {
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import {
  buildSubagentRunReadIndex,
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  listSubagentRunsForController,
  resolveSubagentSessionStatus,
} from "../agents/subagent-registry-read.js";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagent-run-liveness.js";
import { listThinkingLevelOptions } from "../auto-reply/thinking.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildGroupDisplayName,
  loadSessionStore,
  resolveAllAgentSessionStoreTargetsSync,
  resolveAgentMainSessionKey,
  resolveFreshSessionTotalTokens,
  resolveStorePath,
  type SessionEntry,
  type SessionStoreTarget,
  type SessionScope,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import {
  AVATAR_MAX_BYTES,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWorkspaceRelativeAvatarPath,
  resolveAvatarMime,
} from "../shared/avatar-policy.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import {
  readRecentSessionUsageFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync,
  readSessionTitleFieldsFromTranscript,
} from "./session-utils.fs.js";
import type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionRunStatus,
  SessionsListResult,
} from "./session-utils.types.js";

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  attachOpenClawTranscriptMeta,
  capArrayByJsonBytes,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readLatestSessionUsageFromTranscriptAsync,
  readLatestRecentSessionUsageFromTranscriptAsync,
  readRecentSessionUsageFromTranscriptAsync,
  readRecentSessionMessagesAsync,
  readRecentSessionMessagesWithStatsAsync,
  readRecentSessionTranscriptLines,
  readRecentSessionUsageFromTranscript,
  readSessionMessageCountAsync,
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync,
  readSessionPreviewItemsFromTranscript,
  readSessionMessagesAsync,
  visitSessionMessagesAsync,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";
export type { ReadSessionMessagesAsyncOptions } from "./session-utils.fs.js";
export { canonicalizeSpawnedByForAgent, resolveSessionStoreKey } from "./session-store-key.js";
export type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
  SessionsPatchResult,
  SessionsPreviewEntry,
  SessionsPreviewResult,
} from "./session-utils.types.js";

const DERIVED_TITLE_MAX_LEN = 60;

function tryResolveExistingPath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function resolveIdentityAvatarUrl(
  cfg: OpenClawConfig,
  agentId: string,
  avatar: string | undefined,
): string | undefined {
  if (!avatar) {
    return undefined;
  }
  const trimmed = normalizeOptionalString(avatar) ?? "";
  if (!trimmed) {
    return undefined;
  }
  if (isAvatarDataUrl(trimmed) || isAvatarHttpUrl(trimmed)) {
    return trimmed;
  }
  if (!isWorkspaceRelativeAvatarPath(trimmed)) {
    return undefined;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const workspaceRoot = tryResolveExistingPath(workspaceDir) ?? path.resolve(workspaceDir);
  const resolvedCandidate = path.resolve(workspaceRoot, trimmed);
  if (!isPathWithinRoot(workspaceRoot, resolvedCandidate)) {
    return undefined;
  }
  try {
    const opened = openRootFileSync({
      absolutePath: resolvedCandidate,
      rootPath: workspaceRoot,
      rootRealPath: workspaceRoot,
      boundaryLabel: "workspace root",
      maxBytes: AVATAR_MAX_BYTES,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      return undefined;
    }
    try {
      const buffer = fs.readFileSync(opened.fd);
      const mime = resolveAvatarMime(resolvedCandidate);
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch {
    return undefined;
  }
}

function formatSessionIdPrefix(sessionId: string, updatedAt?: number | null): string {
  const prefix = sessionId.slice(0, 8);
  if (updatedAt && updatedAt > 0) {
    const d = new Date(updatedAt);
    const date = d.toISOString().slice(0, 10);
    return `${prefix} (${date})`;
  }
  return prefix;
}

function truncateTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return cut.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  if (normalizeOptionalString(entry.displayName)) {
    return normalizeOptionalString(entry.displayName);
  }

  if (normalizeOptionalString(entry.subject)) {
    return normalizeOptionalString(entry.subject);
  }

  if (firstUserMessage?.trim()) {
    const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
    return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
  }

  if (entry.sessionId) {
    return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
  }

  return undefined;
}

function resolveSessionRuntimeMs(
  run: { startedAt?: number; endedAt?: number; accumulatedRuntimeMs?: number } | null,
  now: number,
) {
  return getSubagentSessionRuntimeMs(run, now);
}

function resolvePositiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveNonNegativeNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolveLatestCompactionCheckpoint(
  entry?: Pick<SessionEntry, "compactionCheckpoints"> | null,
): NonNullable<SessionEntry["compactionCheckpoints"]>[number] | undefined {
  const checkpoints = entry?.compactionCheckpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return undefined;
  }
  return checkpoints.reduce((latest, checkpoint) =>
    !latest || checkpoint.createdAt > latest.createdAt ? checkpoint : latest,
  );
}

function buildCompactionCheckpointPreview(
  checkpoint: NonNullable<SessionEntry["compactionCheckpoints"]>[number] | undefined,
): GatewaySessionRow["latestCompactionCheckpoint"] {
  if (!checkpoint) {
    return undefined;
  }
  const checkpointId = normalizeOptionalString(checkpoint.checkpointId);
  const createdAt = checkpoint.createdAt;
  const reason = checkpoint.reason;
  if (!checkpointId || typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return undefined;
  }
  if (
    reason !== "manual" &&
    reason !== "auto-threshold" &&
    reason !== "overflow-retry" &&
    reason !== "timeout-retry"
  ) {
    return undefined;
  }
  return {
    checkpointId,
    createdAt,
    reason,
  };
}

function resolveEstimatedSessionCostUsd(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  entry?: Pick<
    SessionEntry,
    "estimatedCostUsd" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite"
  >;
  explicitCostUsd?: number;
}): number | undefined {
  const explicitCostUsd = resolveNonNegativeNumber(
    params.explicitCostUsd ?? params.entry?.estimatedCostUsd,
  );
  if (explicitCostUsd !== undefined) {
    return explicitCostUsd;
  }
  const input = resolvePositiveNumber(params.entry?.inputTokens);
  const output = resolvePositiveNumber(params.entry?.outputTokens);
  const cacheRead = resolvePositiveNumber(params.entry?.cacheRead);
  const cacheWrite = resolvePositiveNumber(params.entry?.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.cfg,
  });
  if (!cost) {
    return undefined;
  }
  const estimated = estimateUsageCost({
    usage: {
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    cost,
  });
  return resolveNonNegativeNumber(estimated);
}

const STALE_STORE_ONLY_CHILD_LINK_MS = 60 * 60 * 1_000;

function isFinitePositiveTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isTerminalSessionStatus(status: unknown): status is Exclude<SessionRunStatus, "running"> {
  return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}

function shouldKeepStoreOnlyChildLink(entry: SessionEntry, now: number): boolean {
  if (isTerminalSessionStatus(entry.status) || isFinitePositiveTimestamp(entry.endedAt)) {
    const endedAt = isFinitePositiveTimestamp(entry.endedAt) ? entry.endedAt : entry.updatedAt;
    return (
      isFinitePositiveTimestamp(endedAt) && now - endedAt <= RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS
    );
  }
  if (entry.status === "running" || isFinitePositiveTimestamp(entry.startedAt)) {
    return true;
  }
  return (
    isFinitePositiveTimestamp(entry.updatedAt) &&
    now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS
  );
}

type SessionListRowContext = {
  subagentRuns: ReturnType<typeof buildSubagentRunReadIndex>;
  storeChildSessionsByKey: Map<string, string[]>;
  selectedModelByOverrideRef: Map<string, ReturnType<typeof resolveSessionModelRef>>;
  thinkingMetadataByModelRef: Map<
    string,
    {
      levels: ReturnType<typeof listThinkingLevelOptions>;
      defaultLevel: ReturnType<typeof resolveGatewaySessionThinkingDefault>;
    }
  >;
};

function resolveRuntimeChildSessionKeys(
  controllerSessionKey: string,
  now = Date.now(),
  subagentRuns?: SessionListRowContext["subagentRuns"],
): string[] | undefined {
  const childSessionKeys = new Set<string>();
  const controllerKey = controllerSessionKey.trim();
  const runs = subagentRuns
    ? (subagentRuns.runsByControllerSessionKey.get(controllerKey) ?? [])
    : listSubagentRunsForController(controllerSessionKey);
  for (const entry of runs) {
    const childSessionKey = normalizeOptionalString(entry.childSessionKey);
    if (!childSessionKey) {
      continue;
    }
    const latest = subagentRuns
      ? subagentRuns.getDisplaySubagentRun(childSessionKey)
      : getSessionDisplaySubagentRunByChildSessionKey(childSessionKey);
    if (!latest) {
      continue;
    }
    const latestControllerSessionKey =
      normalizeOptionalString(latest?.controllerSessionKey) ||
      normalizeOptionalString(latest?.requesterSessionKey);
    if (latestControllerSessionKey !== controllerSessionKey) {
      continue;
    }
    if (
      !shouldKeepSubagentRunChildLink(latest, {
        activeDescendants: subagentRuns
          ? subagentRuns.countActiveDescendantRuns(childSessionKey)
          : countActiveDescendantRuns(childSessionKey),
        now,
      })
    ) {
      continue;
    }
    childSessionKeys.add(childSessionKey);
  }
  const childSessions = Array.from(childSessionKeys);
  return childSessions.length > 0 ? childSessions : undefined;
}

function addChildSessionKey(
  childSessionsByKey: Map<string, string[]>,
  parentKey: string,
  childKey: string,
) {
  const current = childSessionsByKey.get(parentKey);
  if (current) {
    if (!current.includes(childKey)) {
      current.push(childKey);
    }
    return;
  }
  childSessionsByKey.set(parentKey, [childKey]);
}

function buildStoreChildSessionIndex(
  store: Record<string, SessionEntry>,
  now = Date.now(),
  subagentRuns?: SessionListRowContext["subagentRuns"],
): Map<string, string[]> {
  const childSessionsByKey = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const parentKeys = [
      normalizeOptionalString(entry.spawnedBy),
      normalizeOptionalString(entry.parentSessionKey),
    ].filter((value): value is string => Boolean(value) && value !== key);
    if (parentKeys.length === 0) {
      continue;
    }
    const latest = subagentRuns
      ? subagentRuns.getDisplaySubagentRun(key)
      : getSessionDisplaySubagentRunByChildSessionKey(key);
    let latestControllerSessionKey: string | undefined;
    if (latest) {
      latestControllerSessionKey =
        normalizeOptionalString(latest.controllerSessionKey) ||
        normalizeOptionalString(latest.requesterSessionKey);
      if (
        !shouldKeepSubagentRunChildLink(latest, {
          activeDescendants: subagentRuns
            ? subagentRuns.countActiveDescendantRuns(key)
            : countActiveDescendantRuns(key),
          now,
        })
      ) {
        continue;
      }
    } else if (!shouldKeepStoreOnlyChildLink(entry, now)) {
      continue;
    }
    for (const parentKey of parentKeys) {
      if (latestControllerSessionKey && latestControllerSessionKey !== parentKey) {
        continue;
      }
      addChildSessionKey(childSessionsByKey, parentKey, key);
    }
  }
  return childSessionsByKey;
}

function buildSessionListRowContext(params: {
  store: Record<string, SessionEntry>;
  now: number;
}): SessionListRowContext {
  const subagentRuns = buildSubagentRunReadIndex(params.now);
  return {
    subagentRuns,
    storeChildSessionsByKey: buildStoreChildSessionIndex(params.store, params.now, subagentRuns),
    selectedModelByOverrideRef: new Map(),
    thinkingMetadataByModelRef: new Map(),
  };
}

function createSessionRowModelCacheKey(provider: string | undefined, model: string | undefined) {
  return `${normalizeLowercaseStringOrEmpty(provider)}\0${normalizeOptionalString(model) ?? ""}`;
}

function resolveSessionSelectedModelRef(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
  rowContext?: SessionListRowContext;
  allowPluginNormalization?: boolean;
}): ReturnType<typeof resolveSessionModelRef> | null {
  const override = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
  });
  if (!override.modelOverride) {
    return null;
  }
  if (!params.rowContext) {
    return resolveSessionModelRef(params.cfg, params.entry, params.agentId, {
      allowPluginNormalization: params.allowPluginNormalization,
    });
  }
  const key = [
    normalizeAgentId(params.agentId),
    override.providerOverride ?? "",
    override.modelOverride,
  ].join("\0");
  const cached = params.rowContext.selectedModelByOverrideRef.get(key);
  if (cached) {
    return cached;
  }
  const selected = resolveSessionModelRef(params.cfg, params.entry, params.agentId, {
    allowPluginNormalization: params.allowPluginNormalization,
  });
  params.rowContext.selectedModelByOverrideRef.set(key, selected);
  return selected;
}

function resolveSessionRowThinkingMetadata(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  modelCatalog?: ModelCatalogEntry[];
  rowContext?: SessionListRowContext;
}): {
  levels: ReturnType<typeof listThinkingLevelOptions>;
  defaultLevel: ReturnType<typeof resolveGatewaySessionThinkingDefault>;
} {
  if (!params.rowContext) {
    return {
      levels: listThinkingLevelOptions(params.provider, params.model, params.modelCatalog),
      defaultLevel: resolveGatewaySessionThinkingDefault({
        cfg: params.cfg,
        provider: params.provider,
        model: params.model,
        agentId: params.agentId,
        modelCatalog: params.modelCatalog,
      }),
    };
  }
  const key = `${normalizeAgentId(params.agentId)}\0${createSessionRowModelCacheKey(
    params.provider,
    params.model,
  )}`;
  const cached = params.rowContext.thinkingMetadataByModelRef.get(key);
  if (cached) {
    return cached;
  }
  const metadata = {
    levels: listThinkingLevelOptions(params.provider, params.model, params.modelCatalog),
    defaultLevel: resolveGatewaySessionThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      agentId: params.agentId,
      modelCatalog: params.modelCatalog,
    }),
  };
  params.rowContext.thinkingMetadataByModelRef.set(key, metadata);
  return metadata;
}

function mergeChildSessionKeys(
  runtimeChildSessions: string[] | undefined,
  storeChildSessions: string[] | undefined,
): string[] | undefined {
  if (!runtimeChildSessions?.length) {
    return storeChildSessions?.length ? storeChildSessions : undefined;
  }
  if (!storeChildSessions?.length) {
    return runtimeChildSessions;
  }
  return Array.from(new Set([...runtimeChildSessions, ...storeChildSessions]));
}

function resolveChildSessionKeys(
  controllerSessionKey: string,
  store: Record<string, SessionEntry>,
  now = Date.now(),
  subagentRuns?: SessionListRowContext["subagentRuns"],
): string[] | undefined {
  const runtimeChildSessions = resolveRuntimeChildSessionKeys(
    controllerSessionKey,
    now,
    subagentRuns,
  );
  const storeChildSessions = buildStoreChildSessionIndex(store, now, subagentRuns).get(
    controllerSessionKey,
  );
  return mergeChildSessionKeys(runtimeChildSessions, storeChildSessions);
}

function resolveTranscriptUsageFallback(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  storePath: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  maxTranscriptBytes?: number;
}): {
  estimatedCostUsd?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
  modelProvider?: string;
  model?: string;
} | null {
  const entry = params.entry;
  if (!entry?.sessionId) {
    return null;
  }
  const parsed = parseAgentSessionKey(params.key);
  const agentId = parsed?.agentId
    ? normalizeAgentId(parsed.agentId)
    : resolveDefaultAgentId(params.cfg);
  const snapshot = readRecentSessionUsageFromTranscript(
    entry.sessionId,
    params.storePath,
    entry.sessionFile,
    agentId,
    typeof params.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : 256 * 1024,
  );
  if (!snapshot) {
    return null;
  }
  const modelProvider = snapshot.modelProvider ?? params.fallbackProvider;
  const model = snapshot.model ?? params.fallbackModel;
  const contextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: modelProvider,
    model,
    // Gateway/session listing is read-only; don't start async model discovery.
    allowAsyncLoad: false,
  });
  const estimatedCostUsd = resolveEstimatedSessionCostUsd({
    cfg: params.cfg,
    provider: modelProvider,
    model,
    explicitCostUsd: snapshot.costUsd,
    entry: {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheRead: snapshot.cacheRead,
      cacheWrite: snapshot.cacheWrite,
    },
  });
  return {
    modelProvider,
    model,
    totalTokens: resolvePositiveNumber(snapshot.totalTokens),
    totalTokensFresh: snapshot.totalTokensFresh === true,
    contextTokens: resolvePositiveNumber(contextTokens),
    estimatedCostUsd,
  };
}

/**
 * Returns the owning agent id if the session key belongs to an agent that is no
 * longer present in config (deleted). Returns null for non-agent legacy/global
 * keys, or when the owning agent still exists (#65524).
 */
export function resolveDeletedAgentIdFromSessionKey(
  cfg: OpenClawConfig,
  sessionKey: string,
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const agentId = normalizeAgentId(parsed.agentId);
  if (listAgentIds(cfg).includes(agentId)) {
    return null;
  }
  return agentId;
}

export function loadSessionEntry(sessionKey: string) {
  const cfg = getRuntimeConfig();
  const key = normalizeOptionalString(sessionKey) ?? "";
  const target = resolveGatewaySessionStoreTarget({
    cfg,
    key,
  });
  const storePath = target.storePath;
  const store = loadSessionStore(storePath);
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(store, target.storeKeys);
  const legacyKey = freshestMatch?.key !== target.canonicalKey ? freshestMatch?.key : undefined;
  return {
    cfg,
    storePath,
    store,
    entry: freshestMatch?.entry,
    canonicalKey: target.canonicalKey,
    legacyKey,
  };
}

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

function findFreshestStoreMatch(
  store: Record<string, SessionEntry>,
  ...candidates: string[]
): { entry: SessionEntry; key: string } | undefined {
  const matches = new Map<string, { entry: SessionEntry; key: string }>();
  for (const candidate of candidates) {
    const trimmed = normalizeOptionalString(candidate) ?? "";
    if (!trimmed) {
      continue;
    }
    const exact = store[trimmed];
    if (exact) {
      matches.set(trimmed, { entry: exact, key: trimmed });
    }
    for (const key of findStoreKeysIgnoreCase(store, trimmed)) {
      const entry = store[key];
      if (entry) {
        matches.set(key, { entry, key });
      }
    }
  }
  if (matches.size === 0) {
    return undefined;
  }
  let freshest: { entry: SessionEntry; key: string } | undefined;
  for (const match of matches.values()) {
    if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

/**
 * Find all on-disk store keys that match the given key case-insensitively.
 * Returns every key from the store whose lowercased form equals the target's lowercased form.
 */
export function findStoreKeysIgnoreCase(
  store: Record<string, unknown>,
  targetKey: string,
): string[] {
  const lowered = normalizeLowercaseStringOrEmpty(targetKey);
  const matches: string[] = [];
  for (const key of Object.keys(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === lowered) {
      matches.push(key);
    }
  }
  return matches;
}

/**
 * Remove legacy key variants for one canonical session key.
 * Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
 */
export function pruneLegacyStoreKeys(params: {
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
    for (const match of findStoreKeysIgnoreCase(params.store, trimmed)) {
      if (match !== params.canonicalKey) {
        keysToDelete.add(match);
      }
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
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
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

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function listExistingAgentIdsFromDisk(): string[] {
  const root = resolveStateDir();
  const agentsDir = path.join(root, "agents");
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);

  for (const entry of cfg.agents?.list ?? []) {
    if (entry?.id) {
      ids.add(normalizeAgentId(entry.id));
    }
  }

  for (const id of listExistingAgentIdsFromDisk()) {
    ids.add(id);
  }

  const sorted = Array.from(ids).filter(Boolean);
  sorted.sort((a, b) => a.localeCompare(b));
  return sorted.includes(defaultId)
    ? [defaultId, ...sorted.filter((id) => id !== defaultId)]
    : sorted;
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

export function listAgentsForGateway(cfg: OpenClawConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<
    string,
    { name?: string; identity?: GatewayAgentRow["identity"] }
  >();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) {
      continue;
    }
    const identity = entry.identity
      ? {
          name: normalizeOptionalString(entry.identity.name),
          theme: normalizeOptionalString(entry.identity.theme),
          emoji: normalizeOptionalString(entry.identity.emoji),
          avatar: normalizeOptionalString(entry.identity.avatar),
          avatarUrl: resolveIdentityAvatarUrl(
            cfg,
            normalizeAgentId(entry.id),
            normalizeOptionalString(entry.identity.avatar),
          ),
        }
      : undefined;
    configuredById.set(normalizeAgentId(entry.id), {
      name: normalizeOptionalString(entry.name),
      identity,
    });
  }
  const explicitIds = new Set(
    (cfg.agents?.list ?? [])
      .map((entry) => (entry?.id ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  let agentIds = listConfiguredAgentIds(cfg).filter((id) =>
    allowedIds ? allowedIds.has(id) : true,
  );
  if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) {
    agentIds = [...agentIds, mainKey];
  }
  const agents = agentIds.map((id) => {
    const meta = configuredById.get(id);
    const model = resolveGatewayAgentModel(cfg, id);
    const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
    return Object.assign(
      {
        id,
        name: meta?.name,
        identity: meta?.identity,
        workspace: resolveAgentWorkspaceDir(cfg, id),
        agentRuntime: resolveModelAgentRuntimeMetadata({
          cfg,
          agentId: id,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
          sessionKey: resolveAgentMainSessionKey({ cfg, agentId: id }),
        }),
      },
      model ? { model } : {},
    );
  });
  return { defaultId, mainKey, scope, agents };
}

function buildGatewaySessionStoreScanTargets(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
}): string[] {
  const targets = new Set<string>();
  if (params.canonicalKey) {
    targets.add(params.canonicalKey);
  }
  if (params.key && params.key !== params.canonicalKey) {
    targets.add(params.key);
  }
  if (params.canonicalKey === "global" || params.canonicalKey === "unknown") {
    return [...targets];
  }
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  if (params.canonicalKey === agentMainKey) {
    targets.add(`agent:${params.agentId}:main`);
  }
  return [...targets];
}

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
): SessionStoreTarget[] {
  const storeConfig = cfg.session?.store;
  const defaultTarget = {
    agentId,
    storePath: resolveStorePath(storeConfig, { agentId }),
  };
  if (!isStorePathTemplate(storeConfig)) {
    return [defaultTarget];
  }
  const targets = new Map<string, SessionStoreTarget>();
  targets.set(defaultTarget.storePath, defaultTarget);
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      targets.set(target.storePath, target);
    }
  }
  return [...targets.values()];
}

function resolveGatewaySessionStoreLookup(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  agentId: string;
  initialStore?: Record<string, SessionEntry>;
}): {
  storePath: string;
  store: Record<string, SessionEntry>;
  match: { entry: SessionEntry; key: string } | undefined;
} {
  const scanTargets = buildGatewaySessionStoreScanTargets(params);
  const candidates = resolveGatewaySessionStoreCandidates(params.cfg, params.agentId);
  const fallback = candidates[0] ?? {
    agentId: params.agentId,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
  };
  let selectedStorePath = fallback.storePath;
  let selectedStore = params.initialStore ?? loadSessionStore(fallback.storePath);
  let selectedMatch = findFreshestStoreMatch(selectedStore, ...scanTargets);
  let selectedUpdatedAt = selectedMatch?.entry.updatedAt ?? Number.NEGATIVE_INFINITY;

  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const store = loadSessionStore(candidate.storePath);
    const match = findFreshestStoreMatch(store, ...scanTargets);
    if (!match) {
      continue;
    }
    const updatedAt = match.entry.updatedAt ?? 0;
    // Mirror combined-store merge behavior so follow-up mutations target the
    // same backing store that won the listing merge when ids collide.
    if (!selectedMatch || updatedAt >= selectedUpdatedAt) {
      selectedStorePath = candidate.storePath;
      selectedStore = store;
      selectedMatch = match;
      selectedUpdatedAt = updatedAt;
    }
  }

  return {
    storePath: selectedStorePath,
    store: selectedStore,
    match: selectedMatch,
  };
}

function resolveExplicitDeletedLegacyMainStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  scanLegacyKeys?: boolean;
}): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} | null {
  const parsed = parseAgentSessionKey(params.key);
  const legacyAgentId = normalizeAgentId(parsed?.agentId);
  if (
    !parsed ||
    legacyAgentId !== DEFAULT_AGENT_ID ||
    listAgentIds(params.cfg).includes(legacyAgentId)
  ) {
    return null;
  }

  // Only preserve agent:main:* when it is backed by a discovered deleted-main store.
  // Shared-store legacy aliases should continue remapping to the configured default agent.
  const canonicalKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: legacyAgentId,
    sessionKey: params.key,
  });
  const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId: legacyAgentId });
  const legacyAgentMainKey = `agent:${legacyAgentId}:main`;
  const lookupSeeds = Array.from(
    new Set([params.key, canonicalKey, agentMainKey, legacyAgentMainKey]),
  );
  let best:
    | {
        storePath: string;
        store: Record<string, SessionEntry>;
        match: { entry: SessionEntry; key: string };
      }
    | undefined;
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg)) {
    if (target.agentId !== legacyAgentId) {
      continue;
    }
    const store = loadSessionStore(target.storePath);
    const match = findFreshestStoreMatch(store, ...lookupSeeds);
    if (!match) {
      continue;
    }
    if (!best || (match.entry.updatedAt ?? 0) >= (best.match.entry.updatedAt ?? 0)) {
      best = { storePath: target.storePath, store, match };
    }
  }
  if (!best) {
    return null;
  }

  const storeKeys = new Set<string>([canonicalKey]);
  if (params.key !== canonicalKey) {
    storeKeys.add(params.key);
  }
  storeKeys.add(best.match.key);
  if (params.scanLegacyKeys !== false) {
    for (const seed of lookupSeeds) {
      storeKeys.add(seed);
      for (const legacyKey of findStoreKeysIgnoreCase(best.store, seed)) {
        storeKeys.add(legacyKey);
      }
    }
  }
  return {
    agentId: legacyAgentId,
    storePath: best.storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  scanLegacyKeys?: boolean;
  store?: Record<string, SessionEntry>;
}): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = normalizeOptionalString(params.key) ?? "";
  const explicitDeletedMainTarget = resolveExplicitDeletedLegacyMainStoreTarget({
    cfg: params.cfg,
    key,
    scanLegacyKeys: params.scanLegacyKeys,
  });
  if (explicitDeletedMainTarget) {
    return explicitDeletedMainTarget;
  }

  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const { storePath, store } = resolveGatewaySessionStoreLookup({
    cfg: params.cfg,
    key,
    canonicalKey,
    agentId,
    initialStore: params.store,
  });

  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys };
  }

  const storeKeys = new Set<string>();
  storeKeys.add(canonicalKey);
  if (key && key !== canonicalKey) {
    storeKeys.add(key);
  }
  if (params.scanLegacyKeys !== false) {
    // Scan the on-disk store for case variants of every target to find
    // legacy mixed-case entries (e.g. "agent:ops:MAIN" when canonical is "agent:ops:work").
    const scanTargets = buildGatewaySessionStoreScanTargets({
      cfg: params.cfg,
      key,
      canonicalKey,
      agentId,
    });
    for (const seed of scanTargets) {
      for (const legacyKey of findStoreKeysIgnoreCase(store, seed)) {
        storeKeys.add(legacyKey);
      }
    }
  }
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";

export function resolveGatewaySessionThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
  modelCatalog?: ModelCatalogEntry[];
}) {
  const agentThinkingDefault = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.thinkingDefault
    : undefined;
  return (
    agentThinkingDefault ??
    resolveThinkingDefault({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      catalog: params.modelCatalog,
    })
  );
}

export function getSessionDefaults(
  cfg: OpenClawConfig,
  modelCatalog?: ModelCatalogEntry[],
  options?: { allowPluginNormalization?: boolean },
): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model, { allowAsyncLoad: false }) ??
    DEFAULT_CONTEXT_TOKENS;
  const thinkingLevels = listThinkingLevelOptions(resolved.provider, resolved.model, modelCatalog);
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
    thinkingLevels,
    thinkingOptions: thinkingLevels.map((level) => level.label),
    thinkingDefault: resolveGatewaySessionThinkingDefault({
      cfg,
      provider: resolved.provider,
      model: resolved.model,
      modelCatalog,
    }),
  };
}

export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider: string; model: string } {
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });
  if (normalizedOverride.providerOverride && normalizedOverride.modelOverride) {
    return resolvePersistedSelectedModelRef({
      defaultProvider: normalizedOverride.providerOverride,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
      allowPluginNormalization: options?.allowPluginNormalization,
    })!;
  }
  const runtimeProvider = normalizeOptionalString(entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(entry?.model);
  if (runtimeProvider && runtimeModel) {
    return { provider: runtimeProvider, model: runtimeModel };
  }

  const resolved = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
        allowPluginNormalization: options?.allowPluginNormalization,
      })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        allowPluginNormalization: options?.allowPluginNormalization,
      });

  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    runtimeProvider,
    runtimeModel,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  if (persisted) {
    return persisted;
  }
  return resolved;
}

export async function resolveGatewayModelSupportsImages(params: {
  loadGatewayModelCatalog: (params?: { readOnly?: boolean }) => Promise<ModelCatalogEntry[]>;
  provider?: string;
  model?: string;
}): Promise<boolean> {
  if (!params.model) {
    return true;
  }

  try {
    const catalog = await params.loadGatewayModelCatalog({ readOnly: false });
    const modelEntry = findModelCatalogEntry(catalog, {
      provider: params.provider,
      modelId: params.model,
    });
    const normalizedProvider = normalizeOptionalLowercaseString(
      params.provider ?? modelEntry?.provider,
    );
    const normalizedCandidates = [
      normalizeLowercaseStringOrEmpty(params.model),
      normalizeLowercaseStringOrEmpty(modelEntry?.name),
    ].filter(Boolean);
    if (modelEntry) {
      if (modelSupportsInput(modelEntry, "image")) {
        return true;
      }
      // Legacy safety shim for stale persisted Foundry rows that predate
      // provider-owned capability normalization.
      if (
        normalizedProvider === "microsoft-foundry" &&
        normalizedCandidates.some(
          (candidate) =>
            candidate.startsWith("gpt-") ||
            candidate.startsWith("o1") ||
            candidate.startsWith("o3") ||
            candidate.startsWith("o4") ||
            candidate === "computer-use-preview",
        )
      ) {
        return true;
      }
      if (
        normalizedProvider === "claude-cli" &&
        normalizedCandidates.some(
          (candidate) =>
            candidate === "opus" ||
            candidate === "sonnet" ||
            candidate === "haiku" ||
            candidate.startsWith("claude-"),
        )
      ) {
        return true;
      }
      return false;
    }
    if (
      normalizedProvider === "claude-cli" &&
      normalizedCandidates.some(
        (candidate) =>
          candidate === "opus" ||
          candidate === "sonnet" ||
          candidate === "haiku" ||
          candidate.startsWith("claude-"),
      )
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveSessionModelIdentityRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
  fallbackModelRef?: string,
  options?: { allowPluginNormalization?: boolean },
): { provider?: string; model: string } {
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER, {
        allowPluginNormalization: options?.allowPluginNormalization,
      });
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER, {
      allowPluginNormalization: options?.allowPluginNormalization,
    });
    if (parsedFallback) {
      return { provider: parsedFallback.provider, model: parsedFallback.model };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: fallbackRef,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: fallbackRef };
    }
    return { model: fallbackRef };
  }
  const resolved = resolveSessionModelRef(cfg, entry, agentId, {
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  return { provider: resolved.provider, model: resolved.model };
}

export function resolveSessionDisplayModelIdentityRef(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider?: string;
  model?: string;
}): { provider?: string; model?: string } {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!provider || !model || !isCliProvider(provider, params.cfg)) {
    return { provider, model };
  }

  const defaultRef = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  if (model.includes("/")) {
    const parsedModel = parseModelRef(model, defaultRef.provider);
    if (parsedModel && !isCliProvider(parsedModel.provider, params.cfg)) {
      return parsedModel;
    }
  }

  const inferredProvider = inferUniqueProviderFromConfiguredModels({
    cfg: params.cfg,
    model,
  });
  if (inferredProvider && !isCliProvider(inferredProvider, params.cfg)) {
    return { provider: inferredProvider, model };
  }

  const parsedModel = parseModelRef(model, defaultRef.provider);
  if (parsedModel && !isCliProvider(parsedModel.provider, params.cfg)) {
    return parsedModel;
  }

  return {
    provider: defaultRef.provider || provider,
    model,
  };
}

export function buildGatewaySessionRow(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: SessionEntry;
  modelCatalog?: ModelCatalogEntry[];
  now?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  transcriptUsageMaxBytes?: number;
  storeChildSessionsByKey?: Map<string, string[]>;
  rowContext?: SessionListRowContext;
  skipTranscriptUsageFallback?: boolean;
  lightweightListRow?: boolean;
}): GatewaySessionRow {
  const { cfg, storePath, store, key, entry } = params;
  const lightweight = params.lightweightListRow === true;
  const skipTranscriptUsage = params.skipTranscriptUsageFallback === true;
  const now = params.now ?? Date.now();
  const updatedAt = entry?.updatedAt ?? null;
  const parsed = parseGroupKey(key);
  const channel = entry?.channel ?? parsed?.channel;
  const subject = entry?.subject;
  const groupChannel = entry?.groupChannel;
  const space = entry?.space;
  const id = parsed?.id;
  const origin = entry?.origin;
  const originLabel = origin?.label;
  const displayName =
    entry?.displayName ??
    (channel
      ? buildGroupDisplayName({
          provider: channel,
          subject,
          groupChannel,
          space,
          id,
          key,
        })
      : undefined) ??
    entry?.label ??
    originLabel;
  const deliveryFields = normalizeSessionDeliveryFields(entry);
  const parsedAgent = parseAgentSessionKey(key);
  const sessionAgentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(cfg));
  const rowContext = params.rowContext;
  const subagentRun = rowContext
    ? rowContext.subagentRuns.getDisplaySubagentRun(key)
    : getSessionDisplaySubagentRunByChildSessionKey(key);
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const liveSubagentRunActive = isSubagentRunLive(subagentRun);
  const persistedSessionStatus = entry?.status;
  const persistedSessionEndedAt = entry?.endedAt;
  const persistedSessionStartedAt = entry?.startedAt;
  const persistedSessionRuntimeMs = entry?.runtimeMs;
  const subagentRunState = subagentRun
    ? liveSubagentRunActive
      ? "active"
      : typeof subagentRun.endedAt === "number" ||
          persistedSessionStatus === "done" ||
          persistedSessionStatus === "failed" ||
          persistedSessionStatus === "killed" ||
          persistedSessionStatus === "timeout" ||
          typeof persistedSessionEndedAt === "number"
        ? "historical"
        : "interrupted"
    : undefined;
  const subagentStatus = subagentRun
    ? liveSubagentRunActive
      ? resolveSubagentSessionStatus(subagentRun)
      : persistedSessionStatus === "running"
        ? undefined
        : (persistedSessionStatus ??
          (typeof subagentRun.endedAt === "number"
            ? resolveSubagentSessionStatus(subagentRun)
            : undefined))
    : undefined;
  const subagentStartedAt = subagentRun
    ? liveSubagentRunActive
      ? getSubagentSessionStartedAt(subagentRun)
      : (persistedSessionStartedAt ?? getSubagentSessionStartedAt(subagentRun))
    : undefined;
  const subagentEndedAt = subagentRun
    ? liveSubagentRunActive
      ? subagentRun.endedAt
      : (persistedSessionEndedAt ?? subagentRun.endedAt)
    : undefined;
  const subagentRuntimeMs = subagentRun
    ? liveSubagentRunActive
      ? resolveSessionRuntimeMs(subagentRun, now)
      : (persistedSessionRuntimeMs ??
        (typeof subagentRun.endedAt === "number"
          ? resolveSessionRuntimeMs(subagentRun, now)
          : undefined))
    : undefined;
  const selectedModel = resolveSessionSelectedModelRef({
    cfg,
    entry,
    agentId: sessionAgentId,
    rowContext,
    allowPluginNormalization: !lightweight,
  });
  const resolvedModel = resolveSessionModelIdentityRef(
    cfg,
    entry,
    sessionAgentId,
    subagentRun?.model,
    { allowPluginNormalization: !lightweight },
  );
  const runtimeModelPresent =
    Boolean(entry?.model?.trim()) || Boolean(entry?.modelProvider?.trim());
  const needsTranscriptTotalTokens =
    resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) === undefined;
  const needsTranscriptContextTokens = resolvePositiveNumber(entry?.contextTokens) === undefined;
  const needsTranscriptEstimatedCostUsd =
    !skipTranscriptUsage &&
    resolveEstimatedSessionCostUsd({
      cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model ?? DEFAULT_MODEL,
      entry,
    }) === undefined;
  const transcriptUsage =
    !skipTranscriptUsage &&
    (needsTranscriptTotalTokens || needsTranscriptContextTokens || needsTranscriptEstimatedCostUsd)
      ? resolveTranscriptUsageFallback({
          cfg,
          key,
          entry,
          storePath,
          fallbackProvider: resolvedModel.provider,
          fallbackModel: resolvedModel.model ?? DEFAULT_MODEL,
          maxTranscriptBytes: params.transcriptUsageMaxBytes,
        })
      : null;
  const preferLiveSubagentModelIdentity =
    Boolean(subagentRun?.model?.trim()) && subagentStatus === "running";
  const shouldUseTranscriptModelIdentity =
    runtimeModelPresent &&
    !preferLiveSubagentModelIdentity &&
    (needsTranscriptTotalTokens || needsTranscriptContextTokens);
  const resolvedModelIdentity = {
    provider: resolvedModel.provider,
    model: resolvedModel.model ?? DEFAULT_MODEL,
  };
  const modelIdentity = shouldUseTranscriptModelIdentity
    ? {
        provider: transcriptUsage?.modelProvider ?? resolvedModelIdentity.provider,
        model: transcriptUsage?.model ?? resolvedModelIdentity.model,
      }
    : resolvedModelIdentity;
  const { provider: modelProvider, model } = modelIdentity;
  const totalTokens =
    resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) ??
    resolvePositiveNumber(transcriptUsage?.totalTokens);
  const totalTokensFresh =
    typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0
      ? true
      : transcriptUsage?.totalTokensFresh === true;
  const childSessions = params.storeChildSessionsByKey
    ? mergeChildSessionKeys(
        resolveRuntimeChildSessionKeys(key, now, rowContext?.subagentRuns),
        params.storeChildSessionsByKey.get(key),
      )
    : resolveChildSessionKeys(key, store, now, rowContext?.subagentRuns);
  const latestCompactionCheckpoint = buildCompactionCheckpointPreview(
    resolveLatestCompactionCheckpoint(entry),
  );
  const selectedOrRuntimeModelProvider = selectedModel?.provider ?? modelProvider;
  const selectedOrRuntimeModel = selectedModel?.model ?? model;
  const rowModelIdentity = lightweight
    ? { provider: selectedOrRuntimeModelProvider, model: selectedOrRuntimeModel }
    : resolveSessionDisplayModelIdentityRef({
        cfg,
        agentId: sessionAgentId,
        provider: selectedOrRuntimeModelProvider,
        model: selectedOrRuntimeModel,
      });
  const rowModelProvider = rowModelIdentity.provider;
  const rowModel = rowModelIdentity.model;
  const agentRuntime = resolveModelAgentRuntimeMetadata({
    cfg,
    agentId: sessionAgentId,
    provider: rowModelProvider,
    model: rowModel,
    sessionKey: key,
  });
  const estimatedCostUsd = lightweight
    ? resolveNonNegativeNumber(entry?.estimatedCostUsd)
    : (resolveEstimatedSessionCostUsd({
        cfg,
        provider: rowModelProvider,
        model: rowModel,
        entry,
      }) ?? resolveNonNegativeNumber(transcriptUsage?.estimatedCostUsd));
  const contextTokens = lightweight
    ? resolvePositiveNumber(entry?.contextTokens)
    : (resolvePositiveNumber(entry?.contextTokens) ??
      resolvePositiveNumber(transcriptUsage?.contextTokens) ??
      resolvePositiveNumber(
        resolveContextTokensForModel({
          cfg,
          provider: rowModelProvider,
          model: rowModel,
          allowAsyncLoad: false,
        }),
      ));

  let derivedTitle: string | undefined;
  let lastMessagePreview: string | undefined;
  if (entry?.sessionId && (params.includeDerivedTitles || params.includeLastMessage)) {
    const fields = readSessionTitleFieldsFromTranscript(
      entry.sessionId,
      storePath,
      entry.sessionFile,
      sessionAgentId,
    );
    if (params.includeDerivedTitles) {
      derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
    }
    if (params.includeLastMessage && fields.lastMessagePreview) {
      lastMessagePreview = fields.lastMessagePreview;
    }
  }

  const thinkingProvider = rowModelProvider ?? DEFAULT_PROVIDER;
  const thinkingModel = rowModel ?? DEFAULT_MODEL;
  const thinkingMetadata = resolveSessionRowThinkingMetadata({
    cfg,
    agentId: sessionAgentId,
    provider: thinkingProvider,
    model: thinkingModel,
    modelCatalog: params.modelCatalog,
    rowContext,
  });
  const thinkingLevels = thinkingMetadata.levels;
  const thinkingDefault = thinkingMetadata.defaultLevel;
  const pluginExtensions =
    !lightweight && entry ? projectPluginSessionExtensionsSync({ sessionKey: key, entry }) : [];

  return {
    key,
    spawnedBy: subagentOwner || entry?.spawnedBy,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    forkedFromParent: entry?.forkedFromParent,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    kind: classifySessionKey(key, entry),
    label: entry?.label,
    displayName,
    derivedTitle,
    lastMessagePreview,
    channel,
    subject,
    groupChannel,
    space,
    chatType: entry?.chatType,
    origin,
    updatedAt,
    sessionId: entry?.sessionId,
    systemSent: entry?.systemSent,
    abortedLastRun: entry?.abortedLastRun,
    thinkingLevel: entry?.thinkingLevel,
    thinkingLevels,
    thinkingOptions: thinkingLevels?.map((level) => level.label),
    thinkingDefault,
    fastMode: entry?.fastMode,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    elevatedLevel: entry?.elevatedLevel,
    sendPolicy: entry?.sendPolicy,
    inputTokens: entry?.inputTokens,
    outputTokens: entry?.outputTokens,
    totalTokens,
    totalTokensFresh,
    estimatedCostUsd,
    status: subagentRun ? subagentStatus : entry?.status,
    subagentRunState,
    hasActiveSubagentRun: subagentRun ? liveSubagentRunActive : undefined,
    startedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
    endedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
    runtimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
    parentSessionKey: subagentOwner || entry?.parentSessionKey,
    childSessions,
    responseUsage: entry?.responseUsage,
    modelProvider: rowModelProvider,
    model: rowModel,
    agentRuntime,
    contextTokens,
    deliveryContext: deliveryFields.deliveryContext,
    lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
    lastTo: deliveryFields.lastTo ?? entry?.lastTo,
    lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
    lastThreadId: deliveryFields.lastThreadId ?? entry?.lastThreadId,
    compactionCheckpointCount: entry?.compactionCheckpoints?.length,
    latestCompactionCheckpoint,
    pluginExtensions: pluginExtensions.length > 0 ? pluginExtensions : undefined,
  };
}

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = entry?.channel ?? parsed?.channel;
  if (!channel) {
    return undefined;
  }
  return buildGroupDisplayName({
    provider: channel,
    subject: entry?.subject,
    groupChannel: entry?.groupChannel,
    space: entry?.space,
    id: parsed?.id,
    key,
  });
}

export function loadGatewaySessionRow(
  sessionKey: string,
  options?: {
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
    now?: number;
    transcriptUsageMaxBytes?: number;
  },
): GatewaySessionRow | null {
  const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntry(sessionKey);
  if (!entry) {
    return null;
  }
  return buildGatewaySessionRow({
    cfg,
    storePath,
    store,
    key: canonicalKey,
    entry,
    now: options?.now,
    includeDerivedTitles: options?.includeDerivedTitles,
    includeLastMessage: options?.includeLastMessage,
    transcriptUsageMaxBytes: options?.transcriptUsageMaxBytes,
  });
}

/**
 * Number of session rows to build per batch before yielding to the event loop.
 * Keeps the main thread responsive during large session list operations while
 * avoiding excessive yielding overhead for small stores.
 */
const SESSIONS_LIST_YIELD_BATCH_SIZE = 10;
const SESSIONS_LIST_TOP_N_LIMIT = 200;
const SESSIONS_LIST_DEFAULT_LIMIT = 100;

type SessionEntryPair = [string, SessionEntry];
type SessionEntrySelection = {
  entries: SessionEntryPair[];
  totalCount: number;
  limitApplied?: number;
};

function compareSessionEntryPairsByUpdatedAt(a: SessionEntryPair, b: SessionEntryPair): number {
  return (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0);
}

function resolveSessionsListLimit(
  opts: import("./protocol/index.js").SessionsListParams,
  defaultLimit?: number,
): number | undefined {
  if (typeof opts.limit !== "number" || !Number.isFinite(opts.limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.floor(opts.limit));
}

function selectNewestLimitedEntries(
  entries: SessionEntryPair[],
  limit: number,
): SessionEntryPair[] {
  const selected: SessionEntryPair[] = [];
  for (const entry of entries) {
    const insertAt = selected.findIndex(
      (candidate) => compareSessionEntryPairsByUpdatedAt(entry, candidate) < 0,
    );
    if (insertAt >= 0) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > limit) {
        selected.pop();
      }
    } else if (selected.length < limit) {
      selected.push(entry);
    }
  }
  return selected;
}

function sortAndLimitSessionEntries(
  entries: SessionEntryPair[],
  limit: number | undefined,
): SessionEntryPair[] {
  if (limit !== undefined && limit <= SESSIONS_LIST_TOP_N_LIMIT) {
    return selectNewestLimitedEntries(entries, limit);
  }
  const sorted = entries.toSorted(compareSessionEntryPairsByUpdatedAt);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

function filterSessionEntries(params: {
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
}): SessionEntryPair[] {
  const { store, opts, now } = params;
  const rowContext = params.rowContext;
  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let entries = Object.entries(store)
    .filter(([key]) => {
      if (isCronRunSessionKey(key)) {
        return false;
      }
      if (!includeGlobal && key === "global") {
        return false;
      }
      if (!includeUnknown && key === "unknown") {
        return false;
      }
      if (agentId) {
        if (key === "global" || key === "unknown") {
          return false;
        }
        const parsed = parseAgentSessionKey(key);
        if (!parsed) {
          return false;
        }
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      return true;
    })
    .filter(([key, entry]) => {
      if (!spawnedBy) {
        return true;
      }
      if (key === "unknown" || key === "global") {
        return false;
      }
      const latest = rowContext
        ? rowContext.subagentRuns.getDisplaySubagentRun(key)
        : getSessionDisplaySubagentRunByChildSessionKey(key);
      if (latest) {
        const latestControllerSessionKey =
          normalizeOptionalString(latest.controllerSessionKey) ||
          normalizeOptionalString(latest.requesterSessionKey);
        return (
          latestControllerSessionKey === spawnedBy &&
          shouldKeepSubagentRunChildLink(latest, {
            activeDescendants: rowContext
              ? rowContext.subagentRuns.countActiveDescendantRuns(key)
              : countActiveDescendantRuns(key),
            now,
          })
        );
      }
      return (
        shouldKeepStoreOnlyChildLink(entry, now) &&
        (entry?.spawnedBy === spawnedBy || entry?.parentSessionKey === spawnedBy)
      );
    })
    .filter(([, entry]) => {
      if (!label) {
        return true;
      }
      return entry?.label === label;
    });

  if (search) {
    entries = entries.filter(([key, entry]) => {
      const fields = [
        resolveSessionListSearchDisplayName(key, entry),
        entry?.label,
        entry?.subject,
        entry?.sessionId,
        key,
      ];
      return fields.some(
        (f) => typeof f === "string" && normalizeLowercaseStringOrEmpty(f).includes(search),
      );
    });
  }

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    entries = entries.filter(([, entry]) => (entry?.updatedAt ?? 0) >= cutoff);
  }

  return entries;
}

function selectSessionEntries(params: {
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
  defaultLimit?: number;
}): SessionEntrySelection {
  const filtered = filterSessionEntries(params);
  const limit = resolveSessionsListLimit(params.opts, params.defaultLimit);
  const entries = sortAndLimitSessionEntries(filtered, limit);
  return {
    entries,
    totalCount: filtered.length,
    limitApplied: limit,
  };
}

export function filterAndSortSessionEntries(params: {
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
  now: number;
  rowContext?: SessionListRowContext;
}): [string, SessionEntry][] {
  return selectSessionEntries(params).entries;
}

export function listSessionsFromStore(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();
  const sessionListTranscriptUsageMaxBytes = 64 * 1024;
  const sessionListTranscriptFieldRows = 100;
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () => {
    rowContext ??= buildSessionListRowContext({ store, now });
    return rowContext;
  };
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const hasSpawnedByFilter = typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0;

  const selection = selectSessionEntries({
    store,
    opts,
    now,
    rowContext: hasSpawnedByFilter ? getRowContext() : undefined,
    defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
  });
  const { entries, totalCount, limitApplied } = selection;

  const sessions = entries.map(([key, entry], index) => {
    const includeTranscriptFields = index < sessionListTranscriptFieldRows;
    return buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key,
      entry,
      modelCatalog: params.modelCatalog,
      now,
      includeDerivedTitles: includeTranscriptFields && includeDerivedTitles,
      includeLastMessage: includeTranscriptFields && includeLastMessage,
      transcriptUsageMaxBytes: sessionListTranscriptUsageMaxBytes,
      storeChildSessionsByKey: getRowContext().storeChildSessionsByKey,
      rowContext: getRowContext(),
    });
  });

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    totalCount,
    limitApplied,
    hasMore: sessions.length < totalCount,
    defaults: getSessionDefaults(cfg, params.modelCatalog, { allowPluginNormalization: false }),
    sessions,
  };
}

/**
 * Async version of listSessionsFromStore that yields to the event loop between
 * batches of session row builds. This prevents large session stores from
 * blocking the event loop during sessions.list requests.
 *
 * The synchronous file I/O in readSessionTitleFieldsFromTranscript (head/tail
 * reads for derived titles and last-message previews) is the dominant blocker.
 * By yielding every SESSIONS_LIST_YIELD_BATCH_SIZE rows, we keep the event
 * loop responsive for WebSocket heartbeats, channel I/O, and concurrent RPC.
 */
export async function listSessionsFromStoreAsync(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  modelCatalog?: ModelCatalogEntry[];
  opts: import("./protocol/index.js").SessionsListParams;
}): Promise<SessionsListResult> {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();
  const sessionListTranscriptUsageMaxBytes = 64 * 1024;
  const sessionListTranscriptFieldRows = 100;
  let rowContext: SessionListRowContext | undefined;
  const getRowContext = () => {
    rowContext ??= buildSessionListRowContext({ store, now });
    return rowContext;
  };
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const hasSpawnedByFilter = typeof opts.spawnedBy === "string" && opts.spawnedBy.length > 0;

  const selection = selectSessionEntries({
    store,
    opts,
    now,
    rowContext: hasSpawnedByFilter ? getRowContext() : undefined,
    defaultLimit: SESSIONS_LIST_DEFAULT_LIMIT,
  });
  const { entries, totalCount, limitApplied } = selection;

  const sessions: GatewaySessionRow[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [key, entry] = entries[i];
    const includeTranscriptFields = i < sessionListTranscriptFieldRows;
    const row = buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key,
      entry,
      modelCatalog: params.modelCatalog,
      now,
      includeDerivedTitles: false,
      includeLastMessage: false,
      transcriptUsageMaxBytes: sessionListTranscriptUsageMaxBytes,
      storeChildSessionsByKey: getRowContext().storeChildSessionsByKey,
      rowContext: getRowContext(),
      skipTranscriptUsageFallback: true,
      lightweightListRow: true,
    });
    if (
      entry?.sessionId &&
      includeTranscriptFields &&
      (includeDerivedTitles || includeLastMessage)
    ) {
      const parsed = parseAgentSessionKey(key);
      const sessionAgentId = parsed?.agentId
        ? normalizeAgentId(parsed.agentId)
        : resolveDefaultAgentId(cfg);
      const fields = await readSessionTitleFieldsFromTranscriptAsync(
        entry.sessionId,
        storePath,
        entry.sessionFile,
        sessionAgentId,
      );
      if (includeDerivedTitles) {
        row.derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
      }
      if (includeLastMessage && fields.lastMessagePreview) {
        row.lastMessagePreview = fields.lastMessagePreview;
      }
    }
    sessions.push(row);
    // Yield to the event loop between batches so WebSocket heartbeats,
    // channel I/O, and concurrent RPC calls are not starved.
    if ((i + 1) % SESSIONS_LIST_YIELD_BATCH_SIZE === 0 && i + 1 < entries.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    totalCount,
    limitApplied,
    hasMore: sessions.length < totalCount,
    defaults: getSessionDefaults(cfg, params.modelCatalog, { allowPluginNormalization: false }),
    sessions,
  };
}
