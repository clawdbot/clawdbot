import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  listSubagentRunsForController,
} from "../agents/subagent-registry-read.js";
import {
  RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS,
  shouldKeepSubagentRunChildLink,
} from "../agents/subagent-run-liveness.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNonNegativeNumber } from "../shared/number-coercion.js";
import { truncateUtf16Safe } from "../utils.js";
import {
  estimateUsageCost,
  type ModelCostConfig,
  resolveModelCostConfig,
} from "../utils/usage-format.js";
import {
  createSessionRowModelCacheKey,
  type SessionListRowContext,
} from "./session-utils-contracts.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

const DERIVED_TITLE_MAX_LEN = 60;

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
  const cut = truncateUtf16Safe(text, maxLen - 1);
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

  const label = normalizeOptionalString(entry.label);
  if (label) {
    return label;
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

export function resolveSessionRuntimeMs(
  run: { startedAt?: number; endedAt?: number; accumulatedRuntimeMs?: number } | null,
  now: number,
) {
  return getSubagentSessionRuntimeMs(run, now);
}

export function resolvePositiveNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function deriveSessionUnread(
  entry?: Pick<
    SessionEntry,
    "lastReadAt" | "markedUnreadAt" | "lastInteractionAt" | "lastActivityAt"
  >,
): boolean {
  return (
    entry?.markedUnreadAt !== undefined ||
    (entry?.lastReadAt !== undefined &&
      Math.max(entry.lastInteractionAt ?? 0, entry.lastActivityAt ?? 0) > entry.lastReadAt)
  );
}

type SessionCompactionCheckpointEntry = NonNullable<SessionEntry["compactionCheckpoints"]>[number];

function isProjectableCompactionCheckpoint(
  value: unknown,
): value is SessionCompactionCheckpointEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const checkpoint = value as {
    checkpointId?: unknown;
    createdAt?: unknown;
    reason?: unknown;
  };
  return (
    Boolean(normalizeOptionalString(checkpoint.checkpointId)) &&
    typeof checkpoint.createdAt === "number" &&
    Number.isFinite(checkpoint.createdAt) &&
    (checkpoint.reason === "manual" ||
      checkpoint.reason === "auto-threshold" ||
      checkpoint.reason === "overflow-retry" ||
      checkpoint.reason === "timeout-retry")
  );
}

export function resolveProjectableCompactionCheckpoints(
  entry?: Pick<SessionEntry, "compactionCheckpoints"> | null,
): SessionCompactionCheckpointEntry[] {
  const checkpoints = entry?.compactionCheckpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return [];
  }
  return checkpoints.filter(isProjectableCompactionCheckpoint);
}

export function resolveLatestCompactionCheckpoint(
  checkpoints: readonly SessionCompactionCheckpointEntry[],
): SessionCompactionCheckpointEntry | undefined {
  return checkpoints.reduce<SessionCompactionCheckpointEntry | undefined>(
    (latest, checkpoint) =>
      !latest || checkpoint.createdAt > latest.createdAt ? checkpoint : latest,
    undefined,
  );
}

export function buildCompactionCheckpointPreview(
  checkpoint: SessionCompactionCheckpointEntry | undefined,
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

function resolveModelCostConfigCached(
  provider: string | undefined,
  model: string | undefined,
  cfg: OpenClawConfig,
  rowContext?: SessionListRowContext,
): ModelCostConfig | undefined {
  if (!rowContext) {
    return resolveModelCostConfig({ provider, model, config: cfg });
  }
  const key = createSessionRowModelCacheKey(provider, model);
  if (rowContext.modelCostConfigByModelRef.has(key)) {
    return rowContext.modelCostConfigByModelRef.get(key);
  }
  const value = resolveModelCostConfig({ provider, model, config: cfg });
  rowContext.modelCostConfigByModelRef.set(key, value);
  return value;
}

export function resolveEstimatedSessionCostUsd(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model?: string;
  entry?: Pick<
    SessionEntry,
    "estimatedCostUsd" | "inputTokens" | "outputTokens" | "cacheRead" | "cacheWrite"
  >;
  explicitCostUsd?: number;
  rowContext?: SessionListRowContext;
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
  const cost = resolveModelCostConfigCached(
    params.provider,
    params.model,
    params.cfg,
    params.rowContext,
  );
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

const SINGLE_ROW_CONTEXT_CACHE_MAX_ENTRIES = 64;

export function isFinitePositiveTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function shouldKeepStoreOnlyChildLink(entry: SessionEntry, now: number): boolean {
  if (isTerminalSessionStatus(entry.status) || isFinitePositiveTimestamp(entry.endedAt)) {
    const endedAt = isFinitePositiveTimestamp(entry.endedAt) ? entry.endedAt : entry.updatedAt;
    return (
      isFinitePositiveTimestamp(endedAt) && now - endedAt <= RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS
    );
  }
  if (entry.status === "running" || isFinitePositiveTimestamp(entry.startedAt)) {
    return true;
  }
  // Store-only child links lack a live subagent registry entry. Keep recent
  // unknown-state rows visible briefly so reloads do not hide fresh children.
  return (
    isFinitePositiveTimestamp(entry.updatedAt) &&
    now - entry.updatedAt <= STALE_STORE_ONLY_CHILD_LINK_MS
  );
}

type SingleRowChildSessionCandidateCacheEntry = {
  store: Record<string, SessionEntry>;
  childSessionCandidatesByParentKey: Map<string, string[]>;
};

const singleRowChildSessionCandidateCache = new Map<
  string,
  SingleRowChildSessionCandidateCacheEntry
>();

function rememberSingleRowChildSessionCandidateCacheEntry(
  storePath: string,
  entry: SingleRowChildSessionCandidateCacheEntry,
) {
  if (singleRowChildSessionCandidateCache.has(storePath)) {
    singleRowChildSessionCandidateCache.delete(storePath);
  }
  singleRowChildSessionCandidateCache.set(storePath, entry);
  if (singleRowChildSessionCandidateCache.size <= SINGLE_ROW_CONTEXT_CACHE_MAX_ENTRIES) {
    return;
  }
  const oldestKey = singleRowChildSessionCandidateCache.keys().next().value;
  if (oldestKey) {
    singleRowChildSessionCandidateCache.delete(oldestKey);
  }
}

function buildStoreChildSessionCandidateIndex(
  store: Record<string, SessionEntry> | null | undefined,
): Map<string, string[]> {
  const childSessionsByKey = new Map<string, string[]>();
  if (!store) {
    return childSessionsByKey;
  }
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const parentKeys = [
      normalizeOptionalString(entry.spawnedBy),
      normalizeOptionalString(entry.parentSessionKey),
    ].filter((value): value is string => Boolean(value) && value !== key);
    for (const parentKey of parentKeys) {
      addChildSessionKey(childSessionsByKey, parentKey, key);
    }
  }
  return childSessionsByKey;
}

export function getSingleRowChildSessionCandidates(params: {
  storePath: string;
  store: Record<string, SessionEntry> | null | undefined;
}): Map<string, string[]> {
  if (!params.store) {
    return new Map();
  }
  const cached = singleRowChildSessionCandidateCache.get(params.storePath);
  if (cached?.store === params.store) {
    return cached.childSessionCandidatesByParentKey;
  }
  const childSessionCandidatesByParentKey = buildStoreChildSessionCandidateIndex(params.store);
  rememberSingleRowChildSessionCandidateCacheEntry(params.storePath, {
    store: params.store,
    childSessionCandidatesByParentKey,
  });
  return childSessionCandidatesByParentKey;
}

export function resolveRuntimeChildSessionKeys(
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

export function buildStoreChildSessionIndex(
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

export function resolveStoreChildSessionKeysFromCandidates(params: {
  store: Record<string, SessionEntry>;
  key: string;
  now: number;
  candidates: ReadonlyMap<string, readonly string[]>;
}): string[] | undefined {
  const childSessionKeys: string[] = [];
  for (const childKey of params.candidates.get(params.key) ?? []) {
    const entry = params.store[childKey];
    if (!entry) {
      continue;
    }
    const latest = getSessionDisplaySubagentRunByChildSessionKey(childKey);
    if (latest) {
      const latestControllerSessionKey =
        normalizeOptionalString(latest.controllerSessionKey) ||
        normalizeOptionalString(latest.requesterSessionKey);
      if (latestControllerSessionKey !== params.key) {
        continue;
      }
      if (
        !shouldKeepSubagentRunChildLink(latest, {
          activeDescendants: countActiveDescendantRuns(childKey),
          now: params.now,
        })
      ) {
        continue;
      }
      childSessionKeys.push(childKey);
      continue;
    }
    if (!shouldKeepStoreOnlyChildLink(entry, params.now)) {
      continue;
    }
    childSessionKeys.push(childKey);
  }
  return childSessionKeys.length > 0 ? childSessionKeys : undefined;
}
