// Session store maintenance prunes stale entries, caps count, and handles quota TTL state.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.shared.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import { parseSessionThreadInfoFast } from "./thread-info.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_RUN_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "enforce";
const DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO = 0.8;
// Conversation history stays in SQLite until physical main-file + WAL + artifact usage crosses
// this budget. Cleanup then extracts historical sessions oldest-first before reclaiming rows.
const DEFAULT_SESSION_MAX_DISK_BYTES = 10 * 1024 * 1024 * 1024;
const STRICT_ENTRY_MAINTENANCE_MAX_ENTRIES = 49;
const MIN_BATCHED_ENTRY_MAINTENANCE_SLACK = 25;
const BATCHED_ENTRY_MAINTENANCE_SLACK_RATIO = 0.1;

export type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

export type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  modelRunPruneAfterMs: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};

export type ResolvedSessionMaintenanceConfigInput = Omit<
  ResolvedSessionMaintenanceConfig,
  "modelRunPruneAfterMs"
> &
  Partial<Pick<ResolvedSessionMaintenanceConfig, "modelRunPruneAfterMs">>;

function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

function resolveResetArchiveRetentionMs(
  maintenance: SessionMaintenanceConfig | undefined,
): number | null {
  // null = keep extracted transcripts indefinitely (the disk budget still removes
  // old archive artifacts under pressure). An explicit duration opts back into
  // wall-clock deletion; parse failures stay on the keep side because losing
  // history is the worse failure mode.
  const raw = maintenance?.resetArchiveRetention;
  if (raw === false) {
    return null;
  }
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return null;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" });
  } catch {
    return null;
  }
}

function resolveMaxDiskBytes(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.maxDiskBytes;
  if (raw === false) {
    return null;
  }
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return DEFAULT_SESSION_MAX_DISK_BYTES;
  }
  try {
    return parseByteSize(normalized, { defaultUnit: "b" });
  } catch {
    // A malformed explicit value must not opt the user into destructive
    // budget cleanup they never chose; disable the budget instead.
    return null;
  }
}

function resolveHighWaterBytes(
  maintenance: SessionMaintenanceConfig | undefined,
  maxDiskBytes: number | null,
): number | null {
  const computeDefault = () => {
    if (maxDiskBytes == null) {
      return null;
    }
    if (maxDiskBytes <= 0) {
      return 0;
    }
    return Math.max(
      1,
      Math.min(
        maxDiskBytes,
        Math.floor(maxDiskBytes * DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO),
      ),
    );
  };
  if (maxDiskBytes == null) {
    return null;
  }
  const raw = maintenance?.highWaterBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return computeDefault();
  }
  try {
    const parsed = parseByteSize(normalized, { defaultUnit: "b" });
    return Math.min(parsed, maxDiskBytes);
  } catch {
    return computeDefault();
  }
}

/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export function resolveMaintenanceConfigFromInput(
  maintenance?: SessionMaintenanceConfig,
): ResolvedSessionMaintenanceConfig {
  const pruneAfterMs = resolvePruneAfterMs(maintenance);
  const maxDiskBytes = resolveMaxDiskBytes(maintenance);
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs,
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    modelRunPruneAfterMs: DEFAULT_MODEL_RUN_PRUNE_AFTER_MS,
    resetArchiveRetentionMs: resolveResetArchiveRetentionMs(maintenance),
    maxDiskBytes,
    highWaterBytes: resolveHighWaterBytes(maintenance, maxDiskBytes),
  };
}

export function normalizeResolvedMaintenanceConfigInput(
  maintenance: ResolvedSessionMaintenanceConfigInput,
): ResolvedSessionMaintenanceConfig {
  return {
    ...maintenance,
    modelRunPruneAfterMs: maintenance.modelRunPruneAfterMs ?? DEFAULT_MODEL_RUN_PRUNE_AFTER_MS,
  };
}

function resolveSessionEntryMaintenanceHighWater(maxEntries: number): number {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    return 1;
  }
  if (maxEntries <= STRICT_ENTRY_MAINTENANCE_MAX_ENTRIES) {
    // Small caps run strictly so operator-configured tiny stores do not drift far past the limit.
    return maxEntries + 1;
  }
  const slack = Math.max(
    MIN_BATCHED_ENTRY_MAINTENANCE_SLACK,
    Math.ceil(maxEntries * BATCHED_ENTRY_MAINTENANCE_SLACK_RATIO),
  );
  return maxEntries + slack;
}

export function shouldRunSessionEntryMaintenance(params: {
  entryCount: number;
  maxEntries: number;
  force?: boolean;
}): boolean {
  if (params.force) {
    return true;
  }
  return params.entryCount >= resolveSessionEntryMaintenanceHighWater(params.maxEntries);
}

export function shouldRunModelRunPrune(params: {
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxEntries">;
  entryCount: number;
  /**
   * True when the caller caps immediately to `maxEntries` in the same pass (forced
   * maintenance / `sessions cleanup`) rather than using the batched high-water trigger.
   */
  force?: boolean;
}): boolean {
  // Model-run cleanup is pressure-gated, and must align with whichever cap step runs alongside it.
  // Forced maintenance caps immediately down to `maxEntries`, so prune stale probes first whenever
  // that cap would actually evict; otherwise stale probes would survive while real sessions get
  // capped (the inverse of #88632). Batched runtime writes instead use the high-water trigger.
  if (params.force) {
    return params.entryCount > params.maintenance.maxEntries;
  }
  return shouldRunSessionEntryMaintenance({
    entryCount: params.entryCount,
    maxEntries: params.maintenance.maxEntries,
  });
}

function isGatewayModelRunSessionKey(sessionKey: string): boolean {
  const match =
    /^agent:([^:\s]+):explicit:model-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(
      sessionKey,
    );
  if (!match) {
    return false;
  }
  const agentId = match[1];
  if (!agentId || /\s/.test(agentId)) {
    return false;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || parsed.agentId !== agentId.toLowerCase()) {
    return false;
  }
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  return /^explicit:model-run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    rest,
  );
}

/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: {
    log?: boolean;
    onPruned?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
  } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfigFromInput().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: opts.preserveKeys })) {
      continue;
    }
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs });
  }
  return pruned;
}

/**
 * Remove stale one-shot gateway model-run probe sessions before normal retention/capping.
 * Existing polluted stores may not carry modelRun metadata, so this intentionally keys off the
 * strict explicit model-run UUID session shape created by the gateway probe CLI path.
 */
export function pruneStaleModelRunEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number | null,
  opts: {
    log?: boolean;
    onPruned?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
  } = {},
): number {
  if (overrideMaxAgeMs == null) {
    return 0;
  }
  const cutoffMs = Date.now() - overrideMaxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: opts.preserveKeys })) {
      continue;
    }
    if (!isGatewayModelRunSessionKey(key)) {
      continue;
    }
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale gateway model-run session entries", {
      pruned,
      maxAgeMs: overrideMaxAgeMs,
    });
  }
  return pruned;
}

const DEFAULT_QUOTA_SUSPENSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const QUOTA_SUSPENSION_CLEANUP_FACTOR = 2; // entries beyond N*ttl are deleted outright

type QuotaSuspensionEntryMaintenanceResult = {
  /** Patch to apply to the entry, or null when no TTL transition is due. */
  patch: Partial<SessionEntry> | null;
  /** Present when the entry transitioned from suspended to resuming. */
  resumed?: { laneId?: string };
  /** True when the quota-suspension marker should be removed. */
  cleared: boolean;
};

/**
 * Resolves the TTL maintenance patch for one session entry without reading or
 * mutating the whole store. Attempt hot paths use this before entry-scoped
 * accessor writes so unrelated sessions stay out of the request path.
 */
export function resolveQuotaSuspensionEntryMaintenance(params: {
  entry: SessionEntry;
  now: number;
  ttlMs?: number;
}): QuotaSuspensionEntryMaintenanceResult {
  const suspension = params.entry.quotaSuspension;
  if (!suspension) {
    return { patch: null, cleared: false };
  }
  const ttlMs = params.ttlMs ?? DEFAULT_QUOTA_SUSPENSION_TTL_MS;
  const cleanupAfterResumeMs = ttlMs * (QUOTA_SUSPENSION_CLEANUP_FACTOR - 1);
  const resumeAtMs = suspension.expectedResumeBy ?? suspension.suspendedAt + ttlMs;
  const cleanupAtMs = resumeAtMs + cleanupAfterResumeMs;
  if (params.now >= cleanupAtMs) {
    return { patch: { quotaSuspension: undefined }, cleared: true };
  }
  if (suspension.state === "suspended" && params.now >= resumeAtMs) {
    return {
      patch: { quotaSuspension: { ...suspension, state: "resuming" } },
      resumed: { laneId: suspension.laneId },
      cleared: false,
    };
  }
  return { patch: null, cleared: false };
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

function isSyntheticSessionMaintenanceKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  // ACP bridge sessions use normal model dispatch, but remain synthetic and disposable.
  return (
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    rest.startsWith("acp-bridge:") ||
    rest.startsWith("hook:") ||
    rest.startsWith("node:") ||
    rest === "heartbeat" ||
    rest.endsWith(":heartbeat") ||
    rest.includes(":heartbeat:")
  );
}

function isTelegramTopicSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  return /^telegram:(?:group|channel|direct|dm):.+:topic:[^:]+$/.test(rest);
}

function isExternalGroupOrChannelSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  return /^[^:]+:(?:group|channel):.+$/.test(rest);
}

function isProtectedSessionMaintenanceEntry(
  sessionKey: string,
  entry: SessionEntry | undefined,
): boolean {
  // Human conversation surfaces are protected; synthetic automation sessions are disposable.
  if (isSyntheticSessionMaintenanceKey(sessionKey)) {
    return false;
  }
  if (parseSessionThreadInfoFast(sessionKey).threadId) {
    return true;
  }
  if (isTelegramTopicSessionKey(sessionKey)) {
    return true;
  }
  if (isExternalGroupOrChannelSessionKey(sessionKey)) {
    return true;
  }
  const chatType = normalizeLowercaseStringOrEmpty(
    entry?.chatType ?? sessionDeliveryOrigin(entry)?.chatType,
  );
  return chatType === "group" || chatType === "channel" || chatType === "thread";
}

export function shouldPreserveMaintenanceEntry(params: {
  key: string;
  entry: SessionEntry | undefined;
  preserveKeys?: ReadonlySet<string>;
}): boolean {
  // Archived sessions are user-shelved; only an explicit sessions.delete may remove them.
  if (params.entry?.archivedAt !== undefined) {
    return true;
  }
  // A model lock is durable harness ownership, not merely a UI restriction.
  // Evicting the row can strand its native runtime binding and later recreate
  // the same conversation under an incompatible model, so pressure may exceed
  // configured retention limits while the lock remains.
  return (
    params.entry?.modelSelectionLocked === true ||
    params.preserveKeys?.has(params.key) === true ||
    isProtectedSessionMaintenanceEntry(params.key, params.entry)
  );
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  if (shouldPreserveMaintenanceEntry({ key: activeSessionKey, entry: activeEntry })) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap = wouldCapActiveSession({
    store: params.store,
    keys,
    activeEntry,
    activeSessionKey,
    maxEntries: params.maxEntries,
  });

  if (!wouldPrune && !wouldCap) {
    return null;
  }

  return {
    activeSessionKey,
    activeUpdatedAt: activeEntry.updatedAt,
    totalEntries: keys.length,
    pruneAfterMs: params.pruneAfterMs,
    maxEntries: params.maxEntries,
    wouldPrune,
    wouldCap,
  };
}

function wouldCapActiveSession(params: {
  store: Record<string, SessionEntry>;
  keys: string[];
  activeEntry: SessionEntry;
  activeSessionKey: string;
  maxEntries: number;
}): boolean {
  if (params.keys.length <= params.maxEntries) {
    return false;
  }
  if (params.maxEntries <= 0) {
    return true;
  }

  const protectedCount = params.keys.filter(
    (key) =>
      key !== params.activeSessionKey &&
      shouldPreserveMaintenanceEntry({ key, entry: params.store[key] }),
  ).length;
  const maxRemovableEntries = Math.max(0, params.maxEntries - protectedCount);
  // If protected entries fill the cap, the active unprotected session would be the one removed.
  if (maxRemovableEntries <= 0) {
    return true;
  }

  const activeUpdatedAt = getEntryUpdatedAt(params.activeEntry);
  let newerOrTieBeforeActive = 0;
  let seenActive = false;
  for (const key of params.keys) {
    if (key === params.activeSessionKey) {
      seenActive = true;
      continue;
    }
    if (shouldPreserveMaintenanceEntry({ key, entry: params.store[key] })) {
      continue;
    }
    const entryUpdatedAt = getEntryUpdatedAt(params.store[key]);
    if (entryUpdatedAt > activeUpdatedAt || (!seenActive && entryUpdatedAt === activeUpdatedAt)) {
      newerOrTieBeforeActive++;
      if (newerOrTieBeforeActive >= maxRemovableEntries) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
export function capEntryCount(
  store: Record<string, SessionEntry>,
  maxEntries: number,
  opts: {
    log?: boolean;
    onCapped?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
  } = {},
): number {
  const preservedCount = Object.entries(store).filter(([key, entry]) =>
    shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: opts.preserveKeys }),
  ).length;
  const maxRemovableEntries = Math.max(0, maxEntries - preservedCount);
  // Protected entries reduce the removable budget instead of being counted as deletion targets.
  const keys = Object.keys(store).filter(
    (key) =>
      !shouldPreserveMaintenanceEntry({
        key,
        entry: store[key],
        preserveKeys: opts.preserveKeys,
      }),
  );
  if (keys.length <= maxRemovableEntries) {
    return 0;
  }

  // Sort by updatedAt descending; entries without updatedAt go to the end (removed first).
  const sorted = keys.toSorted((a, b) => {
    const aTime = getEntryUpdatedAt(store[a]);
    const bTime = getEntryUpdatedAt(store[b]);
    return bTime - aTime;
  });

  const toRemove = sorted.slice(maxRemovableEntries);
  for (const key of toRemove) {
    const entry = store[key];
    if (entry) {
      opts.onCapped?.({ key, entry });
    }
    delete store[key];
  }
  if (opts.log !== false) {
    log.info("capped session entry count", { removed: toRemove.length, maxEntries });
  }
  return toRemove.length;
}
