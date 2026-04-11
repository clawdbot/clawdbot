import fs from "node:fs";
import path from "node:path";
import {
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { lookupContextTokens, resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import {
  inferUniqueProviderFromConfiguredModels,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "../agents/model-selection.js";
import {
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  listSubagentRunsForController,
  resolveSubagentSessionStatus,
} from "../agents/subagent-registry-read.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
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
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
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
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import {
  canonicalizeSessionKeyForAgent,
  canonicalizeSpawnedByForAgent,
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "./session-store-key.js";
import {
  readLatestSessionUsageFromTranscript,
  readSessionTitleFieldsFromTranscript,
} from "./session-utils.fs.js";
import type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
} from "./session-utils.types.js";

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  attachOpenClawTranscriptMeta,
  capArrayByJsonBytes,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readLatestSessionUsageFromTranscript,
  readSessionTitleFieldsFromTranscript,
  readSessionPreviewItemsFromTranscript,
  readSessionMessages,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";
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
    const opened = openBoundaryFileSync({
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

function resolveChildSessionKeys(
  controllerSessionKey: string,
  store: Record<string, SessionEntry>,
): string[] | undefined {
  const childSessionKeys = new Set<string>();
  for (const entry of listSubagentRunsForController(controllerSessionKey)) {
    const childSessionKey = normalizeOptionalString(entry.childSessionKey);
    if (!childSessionKey) {
      continue;
    }
    const latest = getSessionDisplaySubagentRunByChildSessionKey(childSessionKey);
    const latestControllerSessionKey =
      normalizeOptionalString(latest?.controllerSessionKey) ||
      normalizeOptionalString(latest?.requesterSessionKey);
    if (latestControllerSessionKey !== controllerSessionKey) {
      continue;
    }
    childSessionKeys.add(childSessionKey);
  }
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || key === controllerSessionKey) {
      continue;
    }
    const spawnedBy = normalizeOptionalString(entry.spawnedBy);
    const parentSessionKey = normalizeOptionalString(entry.parentSessionKey);
    if (spawnedBy !== controllerSessionKey && parentSessionKey !== controllerSessionKey) {
      continue;
    }
    const latest = getSessionDisplaySubagentRunByChildSessionKey(key);
    if (latest) {
      const latestControllerSessionKey =
        normalizeOptionalString(latest.controllerSessionKey) ||
        normalizeOptionalString(latest.requesterSessionKey);
      if (latestControllerSessionKey !== controllerSessionKey) {
        continue;
      }
    }
    childSessionKeys.add(key);
  }
  const childSessions = Array.from(childSessionKeys);
  return childSessions.length > 0 ? childSessions : undefined;
}

function resolveTranscriptUsageFallback(params: {
  cfg: OpenClawConfig;
  key: string;
  entry?: SessionEntry;
  storePath: string;
  fallbackProvider?: string;
  fallbackModel?: string;
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
  const snapshot = readLatestSessionUsageFromTranscript(
    entry.sessionId,
    params.storePath,
    entry.sessionFile,
    agentId,
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

export function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const { storePath, store } = resolveGatewaySessionStoreLookup({
    cfg,
    key: normalizeOptionalString(sessionKey) ?? "",
    canonicalKey,
    agentId,
  });
  const target = resolveGatewaySessionStoreTarget({
    cfg,
    key: normalizeOptionalString(sessionKey) ?? "",
    store,
  });
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(store, target.storeKeys);
  const legacyKey = freshestMatch?.key !== canonicalKey ? freshestMatch?.key : undefined;
  return { cfg, storePath, store, entry: freshestMatch?.entry, canonicalKey, legacyKey };
}

export function resolveFreshestSessionStoreMatchFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): { key: string; entry: SessionEntry } | undefined {
  const matches = storeKeys
    .map((key) => {
      const entry = store[key];
      return entry ? { key, entry } : undefined;
    })
    .filter((match): match is { key: string; entry: SessionEntry } => match !== undefined);
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return [...matches].toSorted((a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0))[0];
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
  return [...matches.values()].toSorted(
    (a, b) => (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0),
  )[0];
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
  cfg: ReturnType<typeof loadConfig>;
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
    return {
      id,
      name: meta?.name,
      identity: meta?.identity,
      workspace: resolveAgentWorkspaceDir(cfg, id),
      ...(model ? { model } : {}),
    };
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

// Merge with existing entry based on latest timestamp to ensure data consistency and avoid overwriting with less complete data.
function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, existing.spawnedBy ?? entry.spawnedBy),
    };
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy: canonicalizeSpawnedByForAgent(
        cfg,
        agentId,
        entry.spawnedBy ?? existing?.spawnedBy,
      ),
    };
  }
}

export function loadCombinedSessionStoreForGateway(cfg: OpenClawConfig): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadSessionStore(storePath);
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(defaultAgentId, key);
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    return { storePath, store: combined };
  }

  const targets = resolveAllAgentSessionStoreTargetsSync(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadSessionStore(storePath);
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(agentId, key);
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const storePath =
    typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
  return { storePath, store: combined };
}

export function getSessionDefaults(cfg: OpenClawConfig): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model, { allowAsyncLoad: false }) ??
    DEFAULT_CONTEXT_TOKENS;
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
  };
}

export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });

  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });

  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
  });
  if (persisted) {
    return persisted;
  }
  return resolved;
}

export async function resolveGatewayModelSupportsImages(params: {
  loadGatewayModelCatalog: () => Promise<ModelCatalogEntry[]>;
  provider?: string;
  model?: string;
}): Promise<boolean> {
  if (!params.model) {
    return true;
  }

  try {
    const catalog = await params.loadGatewayModelCatalog();
    const modelEntry = catalog.find(
      (entry) =>
        entry.id === params.model && (!params.provider || entry.provider === params.provider),
    );
    const normalizedProvider = normalizeOptionalLowercaseString(params.provider);
    const normalizedCandidates = [
      normalizeLowercaseStringOrEmpty(params.model),
      normalizeLowercaseStringOrEmpty(modelEntry?.name),
    ].filter(Boolean);
    if (modelEntry) {
      if (modelEntry.input?.includes("image")) {
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
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER);
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER);
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
  const resolved = resolveSessionModelRef(cfg, entry, agentId);
  return { provider: resolved.provider, model: resolved.model };
}

export function buildGatewaySessionRow(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: SessionEntry;
  now?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
}): GatewaySessionRow {
  const { cfg, storePath, store, key, entry } = params;
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
  const subagentRun = getSessionDisplaySubagentRunByChildSessionKey(key);
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const subagentStatus = subagentRun ? resolveSubagentSessionStatus(subagentRun) : undefined;
  const subagentStartedAt = subagentRun ? getSubagentSessionStartedAt(subagentRun) : undefined;
  const subagentEndedAt = subagentRun ? subagentRun.endedAt : undefined;
  const subagentRuntimeMs = subagentRun ? resolveSessionRuntimeMs(subagentRun, now) : undefined;
  const selectedModel = entry?.modelOverride?.trim()
    ? resolveSessionModelRef(cfg, entry, sessionAgentId)
    : null;
  const resolvedModel = resolveSessionModelIdentityRef(
    cfg,
    entry,
    sessionAgentId,
    subagentRun?.model,
  );
  const runtimeModelPresent =
    Boolean(entry?.model?.trim()) || Boolean(entry?.modelProvider?.trim());
  const needsTranscriptTotalTokens =
    resolvePositiveNumber(resolveFreshSessionTotalTokens(entry)) === undefined;
  const needsTranscriptContextTokens = resolvePositiveNumber(entry?.contextTokens) === undefined;
  const needsTranscriptEstimatedCostUsd =
    resolveEstimatedSessionCostUsd({
      cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model ?? DEFAULT_MODEL,
      entry,
    }) === undefined;
  const transcriptUsage =
    needsTranscriptTotalTokens || needsTranscriptContextTokens || needsTranscriptEstimatedCostUsd
      ? resolveTranscriptUsageFallback({
          cfg,
          key,
          entry,
          storePath,
          fallbackProvider: resolvedModel.provider,
          fallbackModel: resolvedModel.model ?? DEFAULT_MODEL,
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
  const childSessions = resolveChildSessionKeys(key, store);
  const latestCompactionCheckpoint = resolveLatestCompactionCheckpoint(entry);
  const estimatedCostUsd =
    resolveEstimatedSessionCostUsd({
      cfg,
      provider: modelProvider,
      model,
      entry,
    }) ?? resolveNonNegativeNumber(transcriptUsage?.estimatedCostUsd);
  const contextTokens =
    resolvePositiveNumber(entry?.contextTokens) ??
    resolvePositiveNumber(transcriptUsage?.contextTokens) ??
    resolvePositiveNumber(
      resolveContextTokensForModel({
        cfg,
        provider: modelProvider,
        model,
        // Gateway/session listing is read-only; don't start async model discovery.
        allowAsyncLoad: false,
      }),
    );

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
    fastMode: entry?.fastMode,
    verboseLevel: entry?.verboseLevel,
    reasoningLevel: entry?.reasoningLevel,
    elevatedLevel: entry?.elevatedLevel,
    sendPolicy: entry?.sendPolicy,
    inputTokens: entry?.inputTokens,
    outputTokens: entry?.outputTokens,
    totalTokens,
    totalTokensFresh,
    estimatedCostUsd,
    status: subagentRun ? subagentStatus : entry?.status,
    startedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
    endedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
    runtimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
    parentSessionKey: subagentOwner || entry?.parentSessionKey,
    childSessions,
    responseUsage: entry?.responseUsage,
    modelProvider: selectedModel?.provider ?? modelProvider,
    model: selectedModel?.model ?? model,
    contextTokens,
    deliveryContext: deliveryFields.deliveryContext,
    lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
    lastTo: deliveryFields.lastTo ?? entry?.lastTo,
    lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
    lastThreadId: deliveryFields.lastThreadId ?? entry?.lastThreadId,
    compactionCheckpointCount: entry?.compactionCheckpoints?.length,
    latestCompactionCheckpoint,
  };
}

export function loadGatewaySessionRow(
  sessionKey: string,
  options?: { includeDerivedTitles?: boolean; includeLastMessage?: boolean; now?: number },
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
  });
}

export function listSessionsFromStore(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = normalizeOptionalString(opts.label) ?? "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = normalizeLowercaseStringOrEmpty(opts.search);
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let sessions = Object.entries(store)
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
      const latest = getSessionDisplaySubagentRunByChildSessionKey(key);
      if (latest) {
        const latestControllerSessionKey =
          normalizeOptionalString(latest.controllerSessionKey) ||
          normalizeOptionalString(latest.requesterSessionKey);
        return latestControllerSessionKey === spawnedBy;
      }
      return entry?.spawnedBy === spawnedBy || entry?.parentSessionKey === spawnedBy;
    })
    .filter(([, entry]) => {
      if (!label) {
        return true;
      }
      return entry?.label === label;
    })
    .map(([key, entry]) =>
      buildGatewaySessionRow({
        cfg,
        storePath,
        store,
        key,
        entry,
        now,
        includeDerivedTitles,
        includeLastMessage,
      }),
    )
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (search) {
    sessions = sessions.filter((s) => {
      const fields = [s.displayName, s.label, s.subject, s.sessionId, s.key];
      return fields.some(
        (f) => typeof f === "string" && normalizeLowercaseStringOrEmpty(f).includes(search),
      );
    });
  }

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
  }

  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    const limit = Math.max(1, Math.floor(opts.limit));
    sessions = sessions.slice(0, limit);
  }

  return {
    ts: now,
    path: storePath,
    count: sessions.length,
    defaults: getSessionDefaults(cfg),
    sessions,
  };
}
