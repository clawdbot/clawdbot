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
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { sessionDeliveryOrigin } from "../../utils/delivery-context.shared.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
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
  archiveDashboardAfterMs: number | null;
  maxEntries: number;
  modelRunPruneAfterMs: number;
  preserveRecentMs?: number | null;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};

export type ResolvedSessionMaintenanceConfigInput = Omit<
  ResolvedSessionMaintenanceConfig,
  "archiveDashboardAfterMs" | "modelRunPruneAfterMs"
> &
  Partial<
    Pick<ResolvedSessionMaintenanceConfig, "archiveDashboardAfterMs" | "modelRunPruneAfterMs">
  >;

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

function resolveArchiveDashboardAfterMs(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.archiveDashboardAfter;
  if (raw === false || raw === 0) {
    return null;
  }
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS;
  }
  try {
    const parsed = parseDurationMs(normalized, { defaultUnit: "d" });
    return parsed > 0 ? parsed : null;
  } catch {
    return DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS;
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

function resolvePreserveRecentMs(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.preserveRecent;
  if (raw === false || raw === undefined) {
    return null;
  }
  try {
    return parseDurationMs(normalizeStringifiedOptionalString(raw) ?? "", { defaultUnit: "d" });
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
    const bytes = parseByteSize(normalized, { defaultUnit: "b" });
    // A zero or negative budget is not a usable cap; treat it the same as an
    // explicit disable so maintenance does not delete every session artifact.
    if (bytes <= 0) {
      return null;
    }
    return bytes;
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
  if (maxDiskBytes == null) {
    return null;
  }
  const defaultHighWaterBytes = Math.max(
    1,
    Math.min(maxDiskBytes, Math.floor(maxDiskBytes * DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO)),
  );
  const raw = maintenance?.highWaterBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return defaultHighWaterBytes;
  }
  try {
    const parsed = parseByteSize(normalized, { defaultUnit: "b" });
    // A zero target cannot stop cleanup while any bytes remain, so use the
    // default instead of evicting every unprotected session and archive.
    return parsed > 0 ? Math.min(parsed, maxDiskBytes) : defaultHighWaterBytes;
  } catch {
    return defaultHighWaterBytes;
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
    archiveDashboardAfterMs: resolveArchiveDashboardAfterMs(maintenance),
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    modelRunPruneAfterMs: DEFAULT_MODEL_RUN_PRUNE_AFTER_MS,
    preserveRecentMs: resolvePreserveRecentMs(maintenance),
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
    archiveDashboardAfterMs:
      maintenance.archiveDashboardAfterMs === undefined
        ? DEFAULT_DASHBOARD_ARCHIVE_AFTER_MS
        : maintenance.archiveDashboardAfterMs,
    modelRunPruneAfterMs: maintenance.modelRunPruneAfterMs ?? DEFAULT_MODEL_RUN_PRUNE_AFTER_MS,
    preserveRecentMs: maintenance.preserveRecentMs ?? null,
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
    preserveRecentMs?: number | null;
  } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfigFromInput().pruneAfterMs;
  if (maxAgeMs <= 0) {
    return 0;
  }
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (
      shouldPreserveMaintenanceEntry({
        key,
        entry,
        preserveKeys: opts.preserveKeys,
        preserveRecentMs: opts.preserveRecentMs,
      })
    ) {
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
    preserveRecentMs?: number | null;
  } = {},
): number {
  if (overrideMaxAgeMs == null) {
    return 0;
  }
  const cutoffMs = Date.now() - overrideMaxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (
      shouldPreserveMaintenanceEntry({
        key,
        entry,
        preserveKeys: opts.preserveKeys,
        preserveRecentMs: opts.preserveRecentMs,
      })
    ) {
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
      cleared: false,
    };
  }
  return { patch: null, cleared: false };
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

function getSessionMaintenanceActivityAt(entry: SessionEntry | undefined): number {
  return Math.max(
    entry?.lastInteractionAt ?? 0,
    entry?.lastActivityAt ?? 0,
    entry?.sessionStartedAt ?? 0,
    entry?.updatedAt ?? 0,
  );
}

/** Archive inactive dashboard sessions while retaining runtime-owned or explicitly active keys. */
export function archiveStaleDashboardEntries(
  store: Record<string, SessionEntry>,
  archiveAfterMs: number | null,
  opts: {
    log?: boolean;
    nowMs?: number;
    onArchived?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
  } = {},
): number {
  if (archiveAfterMs == null || archiveAfterMs <= 0) {
    return 0;
  }
  const now = opts.nowMs ?? Date.now();
  const cutoffMs = now - archiveAfterMs;
  let archived = 0;
  for (const [key, entry] of Object.entries(store)) {
    const parsed = parseAgentSessionKey(key);
    if (
      !parsed?.rest.startsWith("dashboard:") ||
      entry.pinnedAt !== undefined ||
      entry.archivedAt !== undefined ||
      opts.preserveKeys?.has(key) === true
    ) {
      continue;
    }
    const activityAt = getSessionMaintenanceActivityAt(entry);
    if (activityAt <= 0 || activityAt >= cutoffMs) {
      continue;
    }
    entry.archivedAt = now;
    opts.onArchived?.({ key, entry });
    archived += 1;
  }
  if (archived > 0 && opts.log !== false) {
    log.info("archived stale dashboard session entries", { archived, archiveAfterMs });
  }
  return archived;
}

function isSyntheticSessionMaintenanceKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  // ACP bridge sessions use normal model dispatch, but remain synthetic and disposable.
  return (
    isGatewayModelRunSessionKey(sessionKey) ||
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

export function isRecentSessionMaintenanceEntry(params: {
  key: string;
  entry: SessionEntry | undefined;
  preserveRecentMs?: number | null;
  nowMs?: number;
}): boolean {
  if (params.preserveRecentMs == null || isSyntheticSessionMaintenanceKey(params.key)) {
    return false;
  }
  const activityAt = getSessionMaintenanceActivityAt(params.entry);
  const now = params.nowMs ?? Date.now();
  return activityAt > 0 && now - activityAt <= params.preserveRecentMs;
}

function isProtectedExternalConversationSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  return (
    /^[^:]+:(?:group|channel):.+$/.test(rest) ||
    /^telegram:(?:direct|dm):.+:topic:[^:]+$/.test(rest)
  );
}

function isPrimarySessionMaintenanceKey(sessionKey: string): boolean {
  if (normalizeLowercaseStringOrEmpty(sessionKey) === "global") {
    return true;
  }
  return parseAgentSessionKey(sessionKey)?.rest === "main";
}

function isProtectedSessionMaintenanceEntry(
  sessionKey: string,
  entry: SessionEntry | undefined,
): boolean {
  // Human conversation surfaces are protected; synthetic automation sessions are disposable.
  if (isSyntheticSessionMaintenanceKey(sessionKey)) {
    return false;
  }
  // Primary sessions are operator-facing and must survive maintenance even without an active
  // admission. Global scope uses the literal `global` key instead of `agent:<id>:main`.
  if (isPrimarySessionMaintenanceKey(sessionKey)) {
    return true;
  }
  if (parseThreadSessionSuffix(sessionKey).threadId) {
    return true;
  }
  if (isProtectedExternalConversationSessionKey(sessionKey)) {
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
  preserveRecentMs?: number | null;
}): boolean {
  // Archived and pinned sessions are user-retained; only an explicit user action may release them.
  if (params.entry?.archivedAt !== undefined || params.entry?.pinnedAt !== undefined) {
    return true;
  }
  // A model lock is durable harness ownership, not merely a UI restriction.
  // Evicting the row can strand its native runtime binding and later recreate
  // the same conversation under an incompatible model, so pressure may exceed
  // configured retention limits while the lock remains.
  return (
    params.entry?.modelSelectionLocked === true ||
    params.preserveKeys?.has(params.key) === true ||
    isRecentSessionMaintenanceEntry(params) ||
    isProtectedSessionMaintenanceEntry(params.key, params.entry)
  );
}

function selectSessionEntryCapVictims(
  store: Record<string, SessionEntry>,
  maxEntries: number,
  preserveKeys?: ReadonlySet<string>,
  preserveRecentMs?: number | null,
): string[] {
  const keys = Object.keys(store);
  const overflow = keys.length - Math.max(0, maxEntries);
  if (overflow <= 0) {
    return [];
  }

  // All persisted rows consume the cap, but protected rows are never victims. If protected rows
  // alone exceed the cap, maintenance removes every eligible row and leaves the excess intact.
  const eligibleKeys = keys.filter(
    (key) =>
      !shouldPreserveMaintenanceEntry({
        key,
        entry: store[key],
        preserveKeys,
        preserveRecentMs,
      }),
  );
  const victimCount = Math.min(overflow, eligibleKeys.length);
  if (victimCount === 0) {
    return [];
  }

  // Sort newest first; entries without updatedAt go to the end and are removed first.
  return eligibleKeys
    .toSorted((a, b) => getEntryUpdatedAt(store[b]) - getEntryUpdatedAt(store[a]))
    .slice(-victimCount);
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
  preserveKeys?: ReadonlySet<string>;
  preserveRecentMs?: number | null;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  if (
    shouldPreserveMaintenanceEntry({
      key: activeSessionKey,
      entry: activeEntry,
      preserveKeys: params.preserveKeys,
      preserveRecentMs: params.preserveRecentMs,
    })
  ) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap = selectSessionEntryCapVictims(
    params.store,
    params.maxEntries,
    params.preserveKeys,
    params.preserveRecentMs,
  ).includes(activeSessionKey);

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

/**
 * Cap the total store to N entries by removing the oldest eviction-eligible rows.
 * Protected rows count toward the cap but are never removed, so a store whose protected rows
 * alone exceed the cap remains above it until protection is released or rows are deleted.
 * Mutates `store` in-place.
 */
export function capEntryCount(
  store: Record<string, SessionEntry>,
  maxEntries: number,
  opts: {
    log?: boolean;
    onCapped?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
    preserveRecentMs?: number | null;
  } = {},
): number {
  const toRemove = selectSessionEntryCapVictims(
    store,
    maxEntries,
    opts.preserveKeys,
    opts.preserveRecentMs,
  );
  if (toRemove.length === 0) {
    return 0;
  }
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
