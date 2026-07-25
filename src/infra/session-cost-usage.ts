import { createHash } from "node:crypto";
// Persists and formats per-session cost and usage records.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import type { NormalizedUsage, UsageLike } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import {
  materializeSessionArchiveForRead,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import {
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import {
  listSessionTranscriptInstances,
  loadTranscriptEventRowsAfterSeqSync,
  loadTranscriptEventsSync,
  readTranscriptEventAtSeqSync,
  readTranscriptStatsSync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/sqlite-marker.js";
import {
  isCanonicalSessionTranscriptEntry,
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
} from "../config/sessions/transcript-tree.js";
import { selectVisibleTranscriptEvents } from "../config/sessions/transcript-visible-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { countToolResults, extractToolCallNames } from "../utils/transcript-tools.js";
import {
  estimateUsageCost,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { formatErrorMessage } from "./errors.js";
import { createTimeZoneDayKeyFormatter } from "./format-time/format-datetime.js";
import {
  acquireSessionCostUsageRefreshLock,
  deleteSessionCostUsageRollupsExcept,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";
import {
  addRollupToCostUsageSummary,
  appendSessionUsageRollupContribution,
  buildSessionCostSummaryFromRollup,
  cloneSessionUsageRollupData,
  createSessionUsageRollupData,
  type SessionUsageRollupData,
} from "./session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals as emptyTotals } from "./session-cost-usage-totals.js";
import type {
  CostBreakdown,
  CostUsageTotals,
  CostUsageSummary,
  DiscoveredSession,
  ParsedTranscriptEntry,
  ParsedUsageEntry,
  SessionCostSummary,
  SessionLogEntry,
  SessionUsageTimePoint,
  SessionUsageTimeSeries,
  UsageCacheStatus,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

export type {
  CostUsageSummary,
  CostUsageTotals,
  DiscoveredSession,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionMessageCounts,
  SessionModelUsage,
  SessionToolUsage,
  UsageCacheStatus,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

// Cache data is rebuildable. Semantic changes get a new version; old rows are
// ignored and rebuilt instead of normalized through a runtime compatibility path.
const USAGE_COST_ROLLUP_VERSION = 2;
const USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY = 32;
const USAGE_COST_FILE_ANCHOR_BYTES = 4096;
const USAGE_COST_DIRECT_REFRESH_RETRY_MS = 25;
const USAGE_COST_REFRESH_RETRY_MIN_MS = 50;
const USAGE_COST_REFRESH_RETRY_MAX_MS = 5_000;
const logger = createSubsystemLogger("usage-cost-cache");

type UsageCostRefreshState = {
  agentId?: string;
  config?: OpenClawConfig;
  databasePath: string;
  fullRefreshRequested: boolean;
  pendingSessionFiles: Set<string>;
  running: boolean;
  sessionsDir: string;
  busyRetryDelayMs: number;
  timer?: ReturnType<typeof setTimeout>;
};

type UsageCostRefreshResult = "refreshed" | "busy";

const usageCostRefreshes = new Map<string, UsageCostRefreshState>();

function resolveUsageCostCacheDatabasePath(agentId?: string): string {
  return resolveOpenClawAgentSqlitePath({ agentId: normalizeAgentId(agentId) });
}

type UsageCostJsonlCheckpoint = {
  kind: "jsonl";
  parsedOffset: number;
  observedSize: number;
  observedMtimeMs: number;
  device: number;
  inode: number;
  anchorHash: string;
};

type UsageCostSqliteCheckpoint = {
  kind: "sqlite";
  maxSeq: number;
  eventCount: number;
  size: number;
  mtimeMs: number;
  anchorHash: string;
  visibleLeafId?: string;
};

type UsageCostRollupEntry = {
  version: number;
  pricingFingerprint: string;
  checkpoint: UsageCostJsonlCheckpoint | UsageCostSqliteCheckpoint;
  scannedAt: number;
  parsedRecords: number;
  countedRecords: number;
  rollup: SessionUsageRollupData;
};

type UsageCostStoredRollup = {
  entry: UsageCostRollupEntry;
  valueJson: string;
};

type UsageCostTranscriptFile = {
  filePath: string;
  kind: "jsonl" | "sqlite";
  size: number;
  mtimeMs: number;
  sessionId?: string;
  device?: number;
  inode?: number;
  eventCount?: number;
  maxSeq?: number;
};

function resolveUsageCostAgentDir(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
): string | undefined {
  return agentId === undefined ? undefined : resolveAgentDir(config ?? {}, agentId);
}

function resolveUsageCostPricingFingerprint(config?: OpenClawConfig, agentDir?: string): string {
  return resolveModelCostConfigFingerprint(config, agentDir);
}

function resolveUsageCostSessionStorePath(params?: {
  agentId?: string;
  sessionsDir?: string;
}): string {
  return params?.sessionsDir
    ? path.join(params.sessionsDir, "sessions.json")
    : resolveDefaultSessionStorePath(params?.agentId);
}

function normalizeUsageCostRollup(
  raw: unknown,
  pricingFingerprint: string,
): UsageCostRollupEntry | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Partial<UsageCostRollupEntry>;
  if (
    record.version !== USAGE_COST_ROLLUP_VERSION ||
    record.pricingFingerprint !== pricingFingerprint ||
    !record.checkpoint ||
    !record.rollup ||
    typeof record.scannedAt !== "number" ||
    typeof record.parsedRecords !== "number" ||
    typeof record.countedRecords !== "number"
  ) {
    return undefined;
  }
  return record as UsageCostRollupEntry;
}

function readUsageCostRollups(
  agentId: string | undefined,
  pricingFingerprint: string,
  databasePath?: string,
): Map<string, UsageCostStoredRollup> {
  const result = new Map<string, UsageCostStoredRollup>();
  for (const row of readSessionCostUsageRollupRows(agentId, databasePath)) {
    try {
      const entry = normalizeUsageCostRollup(JSON.parse(row.valueJson), pricingFingerprint);
      if (entry) {
        result.set(row.key, { entry, valueJson: row.valueJson });
      }
    } catch {
      // Rebuildable cache row. The refresh path replaces it.
    }
  }
  return result;
}

async function listUsageCountedTranscriptFileStats(
  agentId?: string,
  params?: { minMtimeMs?: number; sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  const sessionsDir = params?.sessionsDir ?? resolveSessionTranscriptsDirForAgent(agentId);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const tasks = entries
    .filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name))
    .map((entry) => async (): Promise<UsageCostTranscriptFile | undefined> => {
      const filePath = path.join(sessionsDir, entry.name);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      if (params?.minMtimeMs !== undefined && stats.mtimeMs < params.minMtimeMs) {
        return undefined;
      }
      // Compressed archives normalize to their materialized plain-JSONL cache
      // at discovery, so every downstream size, incremental offset, and cache
      // signature measures decompressed bytes; mixing offset spaces would
      // truncate or overcount archived usage.
      if (filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
        try {
          const materialized = materializeSessionArchiveForRead(filePath);
          const materializedStats = await fs.promises.stat(materialized);
          return {
            filePath: materialized,
            kind: "jsonl",
            size: materializedStats.size,
            mtimeMs: stats.mtimeMs,
            device: materializedStats.dev,
            inode: materializedStats.ino,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }
          throw error;
        }
      }
      return {
        filePath,
        kind: "jsonl",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino,
      };
    });
  const { firstError, hasError, results } = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  if (hasError) {
    throw firstError;
  }
  return results.filter((file): file is UsageCostTranscriptFile => Boolean(file));
}

function listUsageCountedSqliteTranscriptStats(
  agentId?: string,
  params?: { minMtimeMs?: number; sessionsDir?: string },
): UsageCostTranscriptFile[] {
  const storePath = resolveUsageCostSessionStorePath({
    agentId,
    ...(params?.sessionsDir ? { sessionsDir: params.sessionsDir } : {}),
  });
  const files: UsageCostTranscriptFile[] = [];
  for (const instance of listSessionTranscriptInstances({ agentId, storePath })) {
    const marker = parseSqliteSessionFileMarker(instance.entry.sessionFile);
    if (!marker) {
      continue;
    }
    const mtimeMs = instance.updatedAtMs;
    if (params?.minMtimeMs !== undefined && mtimeMs < params.minMtimeMs) {
      continue;
    }
    // Usage scans run across every session on hot paths; byte sizes come from
    // a SQL aggregate so no transcript row is materialized (#86718 class).
    const stats = readTranscriptStatsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    });
    files.push({
      filePath: formatCanonicalUsageCostSqliteMarker(marker),
      kind: "sqlite",
      mtimeMs,
      sessionId: marker.sessionId,
      size: stats.sizeBytes,
      eventCount: stats.eventCount,
      maxSeq: stats.maxSeq,
    });
  }
  return files;
}

function formatCanonicalUsageCostSqliteMarker(marker: SqliteSessionFileMarker): string {
  const storePath =
    resolveSqliteTargetFromSessionStorePath(marker.storePath, { agentId: marker.agentId }).path ??
    resolveOpenClawAgentSqlitePath({ agentId: marker.agentId });
  return formatSqliteSessionFileMarker({ ...marker, storePath });
}

async function listUsageCountedTranscriptFiles(
  agentId?: string,
  params?: { sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  return await listUsageCountedTranscriptStats(agentId, params);
}

async function listUsageCountedTranscriptStats(
  agentId?: string,
  params?: { minMtimeMs?: number; sessionsDir?: string },
): Promise<UsageCostTranscriptFile[]> {
  const fileBacked = await listUsageCountedTranscriptFileStats(agentId, params);
  const sqliteBacked = listUsageCountedSqliteTranscriptStats(agentId, params);
  const sqliteSessionIds = new Set(sqliteBacked.map((file) => file.sessionId).filter(Boolean));
  const canonicalFileBacked = fileBacked.filter((file) => {
    const sessionId = parseUsageCountedSessionIdFromFileName(path.basename(file.filePath));
    return !sessionId || !sqliteSessionIds.has(sessionId);
  });
  return [...canonicalFileBacked, ...sqliteBacked];
}

async function resolveUsageCostTranscriptFile(
  sessionFile: string,
): Promise<UsageCostTranscriptFile | undefined> {
  const marker = parseSqliteSessionFileMarker(sessionFile);
  if (marker) {
    const stats = readTranscriptStatsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    });
    return {
      filePath: formatCanonicalUsageCostSqliteMarker(marker),
      kind: "sqlite",
      mtimeMs: stats.lastMutationAtMs ?? 0,
      sessionId: marker.sessionId,
      size: stats.sizeBytes,
      eventCount: stats.eventCount,
      maxSeq: stats.maxSeq,
    };
  }
  if (sessionFile.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    try {
      const archiveStats = await fs.promises.stat(sessionFile);
      const materialized = materializeSessionArchiveForRead(sessionFile);
      const materializedStats = await fs.promises.stat(materialized);
      return {
        filePath: materialized,
        kind: "jsonl",
        size: materializedStats.size,
        mtimeMs: archiveStats.mtimeMs,
        device: materializedStats.dev,
        inode: materializedStats.ino,
      };
    } catch {
      return undefined;
    }
  }
  const stats = await fs.promises.stat(sessionFile).catch(() => null);
  return stats
    ? {
        filePath: sessionFile,
        kind: "jsonl",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        device: stats.dev,
        inode: stats.ino,
      }
    : undefined;
}

const normalizeUsageCostTotalOrigin = (value: unknown): CostBreakdown["totalOrigin"] =>
  value === "provider-billed" ? value : undefined;

const extractCostBreakdown = (usageRaw?: UsageLike | null): CostBreakdown | undefined => {
  if (!usageRaw || typeof usageRaw !== "object") {
    return undefined;
  }
  const record = usageRaw as Record<string, unknown>;
  const cost = record.cost as Record<string, unknown> | undefined;
  if (!cost) {
    return undefined;
  }

  const total = asFiniteNumber(cost.total);
  if (total === undefined || total < 0) {
    return undefined;
  }

  return {
    total,
    input: asFiniteNumber(cost.input),
    output: asFiniteNumber(cost.output),
    cacheRead: asFiniteNumber(cost.cacheRead),
    cacheWrite: asFiniteNumber(cost.cacheWrite),
    totalOrigin: normalizeUsageCostTotalOrigin(cost.totalOrigin),
  };
};

const parseTimestamp = (entry: Record<string, unknown>): Date | undefined => {
  const message = entry.message as Record<string, unknown> | undefined;
  const messageTimestamp = asFiniteNumber(message?.timestamp);
  if (messageTimestamp !== undefined) {
    const parsed = new Date(messageTimestamp);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  const raw = entry.timestamp;
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  return undefined;
};

const parseTranscriptEntry = (entry: Record<string, unknown>): ParsedTranscriptEntry | null => {
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") {
    return null;
  }

  const roleRaw = message.role;
  const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
  const isStandaloneToolResult = roleRaw === "tool" || roleRaw === "toolResult";
  if (!role && !isStandaloneToolResult) {
    return null;
  }

  const usageRaw =
    (message.usage as UsageLike | undefined) ?? (entry.usage as UsageLike | undefined);
  const usage = usageRaw ? (normalizeUsage(usageRaw) ?? undefined) : undefined;

  const provider =
    (typeof message.provider === "string" ? message.provider : undefined) ??
    (typeof entry.provider === "string" ? entry.provider : undefined);
  const model =
    (typeof message.model === "string" ? message.model : undefined) ??
    (typeof entry.model === "string" ? entry.model : undefined);

  const costBreakdown = extractCostBreakdown(usageRaw);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const durationMs = asFiniteNumber(message.durationMs ?? entry.durationMs);

  return {
    message,
    role,
    timestamp: parseTimestamp(entry),
    durationMs,
    usage,
    costTotal: costBreakdown?.total,
    costBreakdown,
    provider,
    model,
    stopReason,
    toolNames: isStandaloneToolResult ? [] : extractToolCallNames(message),
    toolResultCounts: isStandaloneToolResult
      ? {
          total: 1,
          errors: message.isError === true || message.is_error === true ? 1 : 0,
        }
      : countToolResults(message),
  };
};

const formatUtcDayKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

type UsageDayKeyFormatter = (date: Date) => string;

const createUsageDayKeyFormatter = (dayBucket?: UsageDailyBucket): UsageDayKeyFormatter => {
  if (dayBucket?.mode === "utc-offset") {
    return (date) =>
      formatUtcDayKey(new Date(date.getTime() + dayBucket.utcOffsetMinutes * 60 * 1000));
  }
  const timeZone =
    dayBucket?.mode === "time-zone"
      ? dayBucket.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createTimeZoneDayKeyFormatter(timeZone);
};

/**
 * Maximum window (in days) for which we will zero-fill missing calendar
 * days. Bounded ranges from the UI's range filter top out at 90 days for
 * the explicit picker and "All" is the wildcard escape hatch — anything
 * wider than this threshold is treated as an all-time / open-ended range
 * and falls back to sparse behavior (only days with activity), since a
 * dense series at that scale would produce tens of thousands of zero
 * buckets (e.g. a 1970-based startMs → ~20k entries) without any user
 * value. 366 days covers a full year + leap-day cushion.
 */
const MAX_ZERO_FILL_DAYS = 366;

/**
 * Parse a `YYYY-MM-DD` day key into its UTC calendar-day timestamp. The
 * timestamp is only used to enumerate calendar labels; usage timestamps stay
 * in their requested timezone bucket.
 */
const parseDayKeyToUtcMs = (dayKey: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const monthIdx = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dayMs = Date.UTC(year, monthIdx, day);
  const date = new Date(dayMs);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIdx &&
    date.getUTCDate() === day
    ? dayMs
    : null;
};

/**
 * Ensure the daily map has an entry for every calendar day in [startMs, endMs].
 * Days without activity are inserted with a zero-valued totals bucket so the
 * resulting `daily` series matches the requested range length (one bar per
 * calendar day) instead of only covering days with recorded usage.
 *
 * Day keys must use the same calendar zone as the request range. Otherwise a
 * remote Gateway can return local-date labels for UTC/browser-local ranges,
 * which drops boundary usage when the UI compares calendar windows.
 */
const fillMissingDays = (
  dailyMap: Map<string, CostUsageTotals>,
  startMs: number,
  endMs: number,
  formatDayKey: UsageDayKeyFormatter,
): void => {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const startKey = formatDayKey(new Date(startMs));
  const endKey = formatDayKey(new Date(endMs));
  const startDayMs = parseDayKeyToUtcMs(startKey);
  const endDayMs = parseDayKeyToUtcMs(endKey);
  if (startDayMs === null || endDayMs === null) {
    // Defensive fallback — formatDayKey should always produce a YYYY-MM-DD
    // key, but if locale data ever shifts under us, at least make sure the
    // endpoint days are present so the chart isn't completely empty.
    if (!dailyMap.has(startKey)) {
      dailyMap.set(startKey, emptyTotals());
    }
    if (!dailyMap.has(endKey)) {
      dailyMap.set(endKey, emptyTotals());
    }
    return;
  }
  // Bound the fill by calendar labels, not elapsed milliseconds: DST days can
  // contain 23 or 25 hours. Wider ranges keep their sparse activity-only shape.
  const spanDays = Math.floor((endDayMs - startDayMs) / dayMs) + 1;
  if (spanDays > MAX_ZERO_FILL_DAYS) {
    return;
  }
  const maxIterations = MAX_ZERO_FILL_DAYS + 1;
  for (let cursorMs = startDayMs, i = 0; cursorMs <= endDayMs && i < maxIterations; i += 1) {
    const key = formatUtcDayKey(new Date(cursorMs));
    if (!dailyMap.has(key)) {
      dailyMap.set(key, emptyTotals());
    }
    cursorMs += dayMs;
  }
  if (!dailyMap.has(endKey)) {
    dailyMap.set(endKey, emptyTotals());
  }
};

const countCalendarDays = (
  startMs: number,
  endMs: number,
  formatDayKey: UsageDayKeyFormatter,
): number => {
  const startDayMs = parseDayKeyToUtcMs(formatDayKey(new Date(startMs)));
  const endDayMs = parseDayKeyToUtcMs(formatDayKey(new Date(endMs)));
  if (startDayMs === null || endDayMs === null || endDayMs < startDayMs) {
    return Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
  }
  return Math.floor((endDayMs - startDayMs) / (24 * 60 * 60 * 1000)) + 1;
};

function isUsageCostRollupFresh(params: {
  stored: UsageCostStoredRollup | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.stored?.entry.checkpoint;
  if (!checkpoint || checkpoint.kind !== params.file.kind) {
    return false;
  }
  if (checkpoint.kind === "jsonl") {
    return (
      checkpoint.observedSize === params.file.size &&
      checkpoint.observedMtimeMs === params.file.mtimeMs &&
      checkpoint.device === params.file.device &&
      checkpoint.inode === params.file.inode
    );
  }
  return (
    checkpoint.size === params.file.size &&
    checkpoint.mtimeMs === params.file.mtimeMs &&
    checkpoint.eventCount === params.file.eventCount &&
    checkpoint.maxSeq === params.file.maxSeq
  );
}

function canUseUsageCostRollupForPartial(params: {
  stored: UsageCostStoredRollup | undefined;
  file: UsageCostTranscriptFile;
}): boolean {
  const checkpoint = params.stored?.entry.checkpoint;
  if (!checkpoint || checkpoint.kind !== params.file.kind) {
    return false;
  }
  if (checkpoint.kind === "jsonl") {
    return (
      checkpoint.parsedOffset <= params.file.size &&
      checkpoint.device === params.file.device &&
      checkpoint.inode === params.file.inode
    );
  }
  return checkpoint.maxSeq <= (params.file.maxSeq ?? 0);
}

function getUsageCostStaleRollupFiles(params: {
  rollups: Map<string, UsageCostStoredRollup>;
  files: UsageCostTranscriptFile[];
}): UsageCostTranscriptFile[] {
  return params.files.filter(
    (file) => !isUsageCostRollupFresh({ stored: params.rollups.get(file.filePath), file }),
  );
}

function countUsableUsageCostRollups(params: {
  rollups: Map<string, UsageCostStoredRollup>;
  files: UsageCostTranscriptFile[];
}): number {
  return params.files.reduce(
    (count, file) =>
      count +
      (canUseUsageCostRollupForPartial({ stored: params.rollups.get(file.filePath), file })
        ? 1
        : 0),
    0,
  );
}

function latestUsageCostRollupScan(
  rollups: Map<string, UsageCostStoredRollup>,
): number | undefined {
  let latest = 0;
  for (const { entry } of rollups.values()) {
    latest = Math.max(latest, entry.scannedAt);
  }
  return latest || undefined;
}

function buildCostUsageSummaryFromRollups(params: {
  rollups: Map<string, UsageCostStoredRollup>;
  files: UsageCostTranscriptFile[];
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  refreshing: boolean;
}): CostUsageSummary {
  const dailyMap = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();
  const dayFormatter = createUsageDayKeyFormatter(params.dayBucket);
  const staleFiles = getUsageCostStaleRollupFiles(params);
  const cachedFiles = countUsableUsageCostRollups(params);
  for (const file of params.files) {
    const stored = params.rollups.get(file.filePath);
    if (!canUseUsageCostRollupForPartial({ stored, file }) || !stored) {
      continue;
    }
    addRollupToCostUsageSummary({
      rollup: stored.entry.rollup,
      startMs: params.startMs,
      endMs: params.endMs,
      formatDay: dayFormatter,
      daily: dailyMap,
      totals,
    });
  }
  fillMissingDays(dailyMap, params.startMs, params.endMs, dayFormatter);
  const status = params.refreshing
    ? "refreshing"
    : staleFiles.length > 0
      ? cachedFiles > 0
        ? "partial"
        : "stale"
      : "fresh";
  return {
    updatedAt: Date.now(),
    days: countCalendarDays(params.startMs, params.endMs, dayFormatter),
    daily: Array.from(dailyMap.entries())
      .map(([date, bucket]) => Object.assign({ date }, bucket))
      .toSorted((a, b) => a.date.localeCompare(b.date)),
    totals,
    cacheStatus: {
      status,
      cachedFiles,
      pendingFiles: staleFiles.length,
      staleFiles: staleFiles.length,
      refreshedAt: latestUsageCostRollupScan(params.rollups),
    },
  };
}

const computeUsageTokenTotals = (usage: NormalizedUsage) => {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const componentTotal = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    componentTotal,
    totalTokens: usage.total ?? componentTotal,
  };
};

const applyUsageTotals = (totals: CostUsageTotals, usage: NormalizedUsage) => {
  const usageTotals = computeUsageTokenTotals(usage);
  totals.input += usageTotals.input;
  totals.output += usageTotals.output;
  totals.cacheRead += usageTotals.cacheRead;
  totals.cacheWrite += usageTotals.cacheWrite;
  totals.totalTokens += usageTotals.totalTokens;
};

const applyCostBreakdown = (totals: CostUsageTotals, costBreakdown: CostBreakdown | undefined) => {
  if (costBreakdown === undefined || costBreakdown.total === undefined) {
    return;
  }
  totals.totalCost += costBreakdown.total;
  totals.inputCost += costBreakdown.input ?? 0;
  totals.outputCost += costBreakdown.output ?? 0;
  totals.cacheReadCost += costBreakdown.cacheRead ?? 0;
  totals.cacheWriteCost += costBreakdown.cacheWrite ?? 0;
};

// Legacy function for backwards compatibility (no cost breakdown available)
const applyCostTotal = (
  totals: CostUsageTotals,
  costTotal: number | undefined,
  provider?: string,
  model?: string,
) => {
  if (costTotal === undefined) {
    totals.missingCostEntries += 1;
    const modelKey = `${normalizeOptionalString(provider) ?? "unknown"}/${normalizeOptionalString(model) ?? "unknown"}`;
    totals.missingCostByModel ??= {};
    totals.missingCostByModel[modelKey] = (totals.missingCostByModel[modelKey] ?? 0) + 1;
    return;
  }
  totals.totalCost += costTotal;
};

// A resolved cost config only counts as "known" pricing when it carries at least one
// positive per-token rate (or tiered pricing). An all-zero config is indistinguishable
// from "pricing unknown": e.g. codex models ship cost {input:0,output:0,...} in the
// generated models.json because the Codex backend exposes no per-token price. Treating
// such a config as a real $0 makes usage-cost report confident zero spend, which
// silently blinds every budget/spike safeguard that keys off totalCost.
const isModelPricingKnown = (cost: ReturnType<typeof resolveModelCostConfig>): boolean => {
  if (!cost) {
    return false;
  }
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    return true;
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
};

const shouldPreserveRecordedZeroCost = (costBreakdown: CostBreakdown | undefined): boolean =>
  costBreakdown?.total === 0 &&
  (costBreakdown.totalOrigin === "provider-billed" ||
    [
      costBreakdown.input,
      costBreakdown.output,
      costBreakdown.cacheRead,
      costBreakdown.cacheWrite,
    ].some((value) => value !== undefined && value !== 0));

const shouldRecomputeRecordedZeroCost = (params: {
  cost: ReturnType<typeof resolveModelCostConfig>;
  costBreakdown: CostBreakdown | undefined;
  costTotal: number | undefined;
  usage: NormalizedUsage;
}): boolean =>
  params.costTotal === 0 &&
  !shouldPreserveRecordedZeroCost(params.costBreakdown) &&
  isModelPricingKnown(params.cost) &&
  computeUsageTokenTotals(params.usage).totalTokens > 0;

type UsageCostResolver = (params: {
  provider?: string;
  model?: string;
}) => ReturnType<typeof resolveModelCostConfig>;

function createUsageCostResolver(params?: {
  config?: OpenClawConfig;
  agentDir?: string;
}): UsageCostResolver {
  const cache = new Map<string, ReturnType<typeof resolveModelCostConfig>>();
  return ({ provider, model }) => {
    const key = `${provider ?? ""}\0${model ?? ""}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    const cost = resolveModelCostConfig({
      provider,
      model,
      config: params?.config,
      agentDir: params?.agentDir,
    });
    cache.set(key, cost);
    return cost;
  };
}

function hashUsageCostCheckpoint(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function readJsonlAnchorHash(filePath: string, offset: number): Promise<string | undefined> {
  const start = Math.max(0, offset - USAGE_COST_FILE_ANCHOR_BYTES);
  const length = offset - start;
  if (length === 0) {
    return hashUsageCostCheckpoint("");
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => null);
  if (!handle) {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead === length ? hashUsageCostCheckpoint(buffer) : undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseJsonlRecord(line: Buffer): Record<string, unknown> | undefined {
  const text = line.toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function scanJsonlRange(params: {
  filePath: string;
  startOffset: number;
  endOffset: number;
  onRecord: (record: Record<string, unknown>) => void;
}): Promise<number> {
  if (params.endOffset <= params.startOffset) {
    return params.startOffset;
  }
  const stream = fs.createReadStream(params.filePath, {
    start: params.startOffset,
    end: params.endOffset - 1,
  });
  let carry = Buffer.alloc(0);
  let carryStart = params.startOffset;
  let processedOffset = params.startOffset;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const data = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
      let lineStart = 0;
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, lineStart)) {
        const record = parseJsonlRecord(data.subarray(lineStart, newline));
        if (record) {
          params.onRecord(record);
        }
        processedOffset = carryStart + newline + 1;
        lineStart = newline + 1;
      }
      carry = data.subarray(lineStart);
      carryStart = processedOffset;
    }
    if (carry.length > 0) {
      const record = parseJsonlRecord(carry);
      if (record) {
        params.onRecord(record);
        processedOffset = params.endOffset;
      }
    }
    return processedOffset;
  } finally {
    stream.destroy();
  }
}

async function* readJsonlRecords(
  filePath: string,
  startOffset = 0,
  endOffset?: number,
): AsyncGenerator<Record<string, unknown>> {
  if (endOffset !== undefined && endOffset <= startOffset) {
    return;
  }
  const streamOptions: Parameters<typeof fs.createReadStream>[1] = {
    encoding: "utf-8",
    start: Math.max(0, startOffset),
  };
  if (endOffset !== undefined) {
    streamOptions.end = endOffset - 1;
  }
  const fileStream = fs.createReadStream(filePath, streamOptions);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object") {
          continue;
        }
        yield parsed as Record<string, unknown>;
      } catch {
        // Ignore malformed lines
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

function loadSqliteUsageTranscriptEvents(
  marker: SqliteSessionFileMarker,
): Record<string, unknown>[] {
  return selectVisibleTranscriptEvents(
    loadTranscriptEventsSync({
      agentId: marker.agentId,
      sessionId: marker.sessionId,
      storePath: marker.storePath,
    }),
  ).filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object" && !Array.isArray(event),
  );
}

async function* readTranscriptRecords(
  filePath: string,
  startOffset = 0,
  endOffset?: number,
): AsyncGenerator<Record<string, unknown>> {
  const marker = parseSqliteSessionFileMarker(filePath);
  if (marker) {
    for (const event of loadSqliteUsageTranscriptEvents(marker)) {
      yield event;
    }
    return;
  }
  // Discovery normalizes compressed archives to their materialized cache, so
  // this branch only serves direct callers that pass a raw .zst path; those
  // callers never carry persisted offsets, keeping the range space coherent.
  if (filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX)) {
    yield* readJsonlRecords(materializeSessionArchiveForRead(filePath), startOffset, endOffset);
    return;
  }
  yield* readJsonlRecords(filePath, startOffset, endOffset);
}

async function* readTranscriptRecordsBestEffort(
  filePath: string,
): AsyncGenerator<Record<string, unknown>> {
  try {
    yield* readTranscriptRecords(filePath);
  } catch {
    // Diagnostic readers return the records available before a stream failure.
    // Durable cache scans use the strict reader so partial data is never marked fresh.
  }
}

function parseUsageCostTranscriptEntry(
  parsed: Record<string, unknown>,
  resolveCost: UsageCostResolver,
): ParsedTranscriptEntry | null {
  const entry = parseTranscriptEntry(parsed);
  if (!entry?.usage) {
    return entry;
  }
  const cost = resolveCost({ provider: entry.provider, model: entry.model });
  const usageTotals = computeUsageTokenTotals(entry.usage);
  const pricingKnown = isModelPricingKnown(cost);
  const preserveRecordedZeroCost = shouldPreserveRecordedZeroCost(entry.costBreakdown);
  if (cost?.tieredPricing && cost.tieredPricing.length > 0 && !preserveRecordedZeroCost) {
    entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
    entry.costBreakdown = undefined;
  } else if (
    !pricingKnown &&
    !preserveRecordedZeroCost &&
    (entry.costTotal === undefined || entry.costTotal === 0) &&
    usageTotals.totalTokens > 0
  ) {
    entry.costTotal = undefined;
    entry.costBreakdown = undefined;
  } else if (
    entry.costTotal === undefined ||
    shouldRecomputeRecordedZeroCost({
      usage: entry.usage,
      cost,
      costBreakdown: entry.costBreakdown,
      costTotal: entry.costTotal,
    })
  ) {
    entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
    entry.costBreakdown = undefined;
  }
  return entry;
}

async function scanTranscriptFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  resolveCost?: UsageCostResolver;
  startOffset?: number;
  endOffset?: number;
  onEntry: (entry: ParsedTranscriptEntry) => void;
}): Promise<void> {
  const resolveCost = params.resolveCost ?? createUsageCostResolver({ config: params.config });
  for await (const parsed of readTranscriptRecords(
    params.filePath,
    params.startOffset,
    params.endOffset,
  )) {
    const entry = parseUsageCostTranscriptEntry(parsed, resolveCost);
    if (!entry) {
      continue;
    }
    params.onEntry(entry);
  }
}

async function scanUsageFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  resolveCost?: UsageCostResolver;
  startOffset?: number;
  endOffset?: number;
  onEntry: (entry: ParsedUsageEntry) => void;
}): Promise<void> {
  await scanTranscriptFile({
    filePath: params.filePath,
    config: params.config,
    resolveCost: params.resolveCost,
    startOffset: params.startOffset,
    endOffset: params.endOffset,
    onEntry: (entry) => {
      if (!entry.usage) {
        return;
      }
      params.onEntry({
        usage: entry.usage,
        costTotal: entry.costTotal,
        costBreakdown: entry.costBreakdown,
        provider: entry.provider,
        model: entry.model,
        timestamp: entry.timestamp,
      });
    },
  });
}

export function resolveExistingUsageSessionFile(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  agentId?: string;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  const entryMarker = parseSqliteSessionFileMarker(params.sessionEntry?.sessionFile);
  const explicitMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const sqliteMarker = entryMarker ?? explicitMarker;
  if (sqliteMarker) {
    if (sessionId && sqliteMarker.sessionId !== sessionId) {
      return undefined;
    }
    return formatSqliteSessionFileMarker(sqliteMarker);
  }

  const candidate =
    params.sessionFile ??
    (sessionId
      ? resolveSessionFilePath(sessionId, params.sessionEntry, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }
  if (!sessionId) {
    return candidate;
  }

  try {
    const sessionsDir = candidate
      ? path.dirname(candidate)
      : resolveSessionTranscriptsDirForAgent(params.agentId);
    const baseFileName = `${sessionId}.jsonl`;
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => {
      return (
        entry.isFile() &&
        (entry.name === baseFileName ||
          entry.name.startsWith(`${baseFileName}.reset.`) ||
          entry.name.startsWith(`${baseFileName}.deleted.`))
      );
    });

    const primary = entries.find((entry) => entry.name === baseFileName);
    if (primary) {
      return path.join(sessionsDir, primary.name);
    }

    const latestArchive = entries
      .filter((entry) => isSessionArchiveArtifactName(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => {
        const tsA =
          parseSessionArchiveTimestamp(a, "deleted") ??
          parseSessionArchiveTimestamp(a, "reset") ??
          0;
        const tsB =
          parseSessionArchiveTimestamp(b, "deleted") ??
          parseSessionArchiveTimestamp(b, "reset") ??
          0;
        return tsB - tsA || b.localeCompare(a);
      })[0];

    return latestArchive ? path.join(sessionsDir, latestArchive) : candidate;
  } catch {
    return candidate;
  }
}

export async function loadCostUsageSummary(params?: {
  startMs?: number;
  endMs?: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<CostUsageSummary> {
  const now = Date.now();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 29);
  const startMs = params?.startMs ?? defaultStart.getTime();
  const endMs = params?.endMs ?? now;
  const agentDir = resolveUsageCostAgentDir(params?.config, params?.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params?.agentId);
  const result = await refreshCostUsageCacheForAgent({
    config: params?.config,
    agentId: params?.agentId,
    agentDir,
    databasePath,
  });
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params?.config, agentDir);
  const rollups = readUsageCostRollups(params?.agentId, pricingFingerprint, databasePath);
  const files = await listUsageCountedTranscriptFiles(params?.agentId);
  return buildCostUsageSummaryFromRollups({
    rollups,
    files,
    startMs,
    endMs,
    dayBucket: params?.dayBucket,
    refreshing:
      result === "busy" ||
      usageCostRefreshes.has(databasePath) ||
      isSessionCostUsageRefreshRunning(params?.agentId, databasePath),
  });
}

function appendParsedEntryToRollup(
  rollup: SessionUsageRollupData,
  entry: ParsedTranscriptEntry,
): { countedRecord: boolean; parsedRecord: boolean } {
  let usageTotals: CostUsageTotals | undefined;
  if (entry.usage) {
    usageTotals = emptyTotals();
    applyUsageTotals(usageTotals, entry.usage);
    if (entry.costBreakdown?.total !== undefined) {
      applyCostBreakdown(usageTotals, entry.costBreakdown);
    } else {
      applyCostTotal(usageTotals, entry.costTotal, entry.provider, entry.model);
    }
  }
  const timestamp = entry.timestamp?.getTime();
  appendSessionUsageRollupContribution(rollup, {
    timestamp,
    role: entry.role,
    durationMs: entry.durationMs,
    provider: entry.provider,
    model: entry.model,
    stopReason: entry.stopReason,
    toolNames: entry.toolNames,
    toolResultCounts: entry.toolResultCounts,
    usageTotals,
  });
  return { parsedRecord: Boolean(entry.usage), countedRecord: Boolean(entry.usage && timestamp) };
}

function scanRecordsIntoRollup(params: {
  records: Iterable<Record<string, unknown>>;
  rollup: SessionUsageRollupData;
  resolveCost: UsageCostResolver;
}): { countedRecords: number; parsedRecords: number } {
  let countedRecords = 0;
  let parsedRecords = 0;
  for (const record of params.records) {
    const entry = parseUsageCostTranscriptEntry(record, params.resolveCost);
    if (!entry) {
      continue;
    }
    const counted = appendParsedEntryToRollup(params.rollup, entry);
    countedRecords += counted.countedRecord ? 1 : 0;
    parsedRecords += counted.parsedRecord ? 1 : 0;
  }
  return { countedRecords, parsedRecords };
}

async function scanJsonlUsageRollup(params: {
  file: UsageCostTranscriptFile;
  previous?: UsageCostStoredRollup;
  pricingFingerprint: string;
  resolveCost: UsageCostResolver;
}): Promise<UsageCostRollupEntry> {
  const previousCheckpoint =
    params.previous?.entry.checkpoint.kind === "jsonl"
      ? params.previous.entry.checkpoint
      : undefined;
  const identityMatches =
    previousCheckpoint &&
    previousCheckpoint.device === params.file.device &&
    previousCheckpoint.inode === params.file.inode &&
    previousCheckpoint.parsedOffset <= params.file.size &&
    params.file.size > previousCheckpoint.observedSize;
  const previousAnchor = identityMatches
    ? await readJsonlAnchorHash(params.file.filePath, previousCheckpoint.parsedOffset)
    : undefined;
  const appendOnly = Boolean(
    identityMatches && previousAnchor === previousCheckpoint?.anchorHash && params.previous,
  );
  const startOffset = appendOnly ? (previousCheckpoint?.parsedOffset ?? 0) : 0;
  const rollup =
    appendOnly && params.previous
      ? cloneSessionUsageRollupData(params.previous.entry.rollup)
      : createSessionUsageRollupData();
  let countedRecords = 0;
  let parsedRecords = 0;
  const processedOffset = await scanJsonlRange({
    filePath: params.file.filePath,
    startOffset,
    endOffset: params.file.size,
    onRecord: (record) => {
      const entry = parseUsageCostTranscriptEntry(record, params.resolveCost);
      if (!entry) {
        return;
      }
      const counted = appendParsedEntryToRollup(rollup, entry);
      countedRecords += counted.countedRecord ? 1 : 0;
      parsedRecords += counted.parsedRecord ? 1 : 0;
    },
  });
  const postStats = await fs.promises.stat(params.file.filePath);
  if (
    postStats.dev !== params.file.device ||
    postStats.ino !== params.file.inode ||
    postStats.size < params.file.size
  ) {
    throw new Error(`transcript changed identity while scanning: ${params.file.filePath}`);
  }
  const anchorHash = await readJsonlAnchorHash(params.file.filePath, processedOffset);
  if (!anchorHash) {
    throw new Error(`transcript checkpoint unavailable: ${params.file.filePath}`);
  }
  return {
    version: USAGE_COST_ROLLUP_VERSION,
    pricingFingerprint: params.pricingFingerprint,
    checkpoint: {
      kind: "jsonl",
      parsedOffset: processedOffset,
      observedSize: params.file.size,
      observedMtimeMs: params.file.mtimeMs,
      device: params.file.device ?? 0,
      inode: params.file.inode ?? 0,
      anchorHash,
    },
    scannedAt: Date.now(),
    parsedRecords: (appendOnly ? (params.previous?.entry.parsedRecords ?? 0) : 0) + parsedRecords,
    countedRecords:
      (appendOnly ? (params.previous?.entry.countedRecords ?? 0) : 0) + countedRecords,
    rollup,
  };
}

function selectIncrementalSqliteRecords(
  records: Record<string, unknown>[],
  previousLeafId: string | undefined,
): { records: Record<string, unknown>[]; visibleLeafId?: string } | undefined {
  let visibleLeafId = previousLeafId;
  const visible: Record<string, unknown>[] = [];
  for (const record of records) {
    if (isSessionTranscriptLeafControl(record) || record.appendMode === "side") {
      return undefined;
    }
    if (!isCanonicalSessionTranscriptEntry(record)) {
      continue;
    }
    const id = typeof record.id === "string" && record.id ? record.id : undefined;
    if (!id) {
      return undefined;
    }
    if (Object.hasOwn(record, "parentId")) {
      const parentId = record.parentId === null ? undefined : record.parentId;
      if (parentId !== visibleLeafId) {
        return undefined;
      }
    }
    visible.push(record);
    visibleLeafId = id;
  }
  return { records: visible, ...(visibleLeafId ? { visibleLeafId } : {}) };
}

function sqliteCheckpointAnchorHash(event: unknown): string {
  return hashUsageCostCheckpoint(JSON.stringify(event));
}

async function scanSqliteUsageRollup(params: {
  file: UsageCostTranscriptFile;
  previous?: UsageCostStoredRollup;
  pricingFingerprint: string;
  resolveCost: UsageCostResolver;
}): Promise<UsageCostRollupEntry> {
  const marker = parseSqliteSessionFileMarker(params.file.filePath);
  if (!marker) {
    throw new Error(`invalid SQLite transcript marker: ${params.file.filePath}`);
  }
  const maxSeq = params.file.maxSeq ?? 0;
  const eventCount = params.file.eventCount ?? 0;
  const scope = {
    agentId: marker.agentId,
    sessionId: marker.sessionId,
    storePath: marker.storePath,
  };
  const snapshotLastRow = maxSeq > 0 ? readTranscriptEventAtSeqSync(scope, maxSeq) : undefined;
  if (maxSeq > 0 && !snapshotLastRow) {
    throw new Error(`SQLite transcript checkpoint unavailable: ${params.file.filePath}`);
  }
  const snapshotAnchorHash = snapshotLastRow
    ? sqliteCheckpointAnchorHash(snapshotLastRow.event)
    : hashUsageCostCheckpoint("");
  const previousCheckpoint =
    params.previous?.entry.checkpoint.kind === "sqlite"
      ? params.previous.entry.checkpoint
      : undefined;
  const previousAnchor = previousCheckpoint?.maxSeq
    ? readTranscriptEventAtSeqSync(scope, previousCheckpoint.maxSeq)
    : undefined;
  const anchorMatches =
    previousCheckpoint?.maxSeq === 0 ||
    (previousAnchor &&
      sqliteCheckpointAnchorHash(previousAnchor.event) === previousCheckpoint?.anchorHash);
  const appendCandidate = Boolean(
    params.previous &&
    previousCheckpoint &&
    previousCheckpoint.maxSeq < maxSeq &&
    previousCheckpoint.eventCount < eventCount &&
    anchorMatches,
  );
  const afterSeq = appendCandidate ? (previousCheckpoint?.maxSeq ?? 0) : 0;
  const rows = loadTranscriptEventRowsAfterSeqSync(scope, afterSeq, maxSeq);
  const rawRecords = rows.flatMap((row) =>
    row.event && typeof row.event === "object" && !Array.isArray(row.event)
      ? [row.event as Record<string, unknown>]
      : [],
  );
  const incremental = appendCandidate
    ? selectIncrementalSqliteRecords(rawRecords, previousCheckpoint?.visibleLeafId)
    : undefined;
  const appendOnly = Boolean(incremental && params.previous);
  const allRows = appendOnly ? rows : loadTranscriptEventRowsAfterSeqSync(scope, 0, maxSeq);
  const allRecords = appendOnly
    ? (incremental?.records ?? [])
    : selectVisibleTranscriptEvents(allRows.map((row) => row.event)).flatMap((event) =>
        event && typeof event === "object" && !Array.isArray(event)
          ? [event as Record<string, unknown>]
          : [],
      );
  const rollup =
    appendOnly && params.previous
      ? cloneSessionUsageRollupData(params.previous.entry.rollup)
      : createSessionUsageRollupData();
  const counts = scanRecordsIntoRollup({
    records: allRecords,
    rollup,
    resolveCost: params.resolveCost,
  });
  const postFile = await resolveUsageCostTranscriptFile(params.file.filePath);
  if (!postFile || (postFile.maxSeq ?? 0) < maxSeq || (postFile.eventCount ?? 0) < eventCount) {
    throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
  }
  const currentLastRow = maxSeq > 0 ? readTranscriptEventAtSeqSync(scope, maxSeq) : undefined;
  if (
    (maxSeq > 0 && !currentLastRow) ||
    (currentLastRow && sqliteCheckpointAnchorHash(currentLastRow.event) !== snapshotAnchorHash)
  ) {
    throw new Error(`SQLite transcript changed while scanning: ${params.file.filePath}`);
  }
  const visibleLeafId = appendOnly
    ? incremental?.visibleLeafId
    : (scanSessionTranscriptTree(allRows.map((row) => row.event)).leafId ?? undefined);
  return {
    version: USAGE_COST_ROLLUP_VERSION,
    pricingFingerprint: params.pricingFingerprint,
    checkpoint: {
      kind: "sqlite",
      maxSeq,
      eventCount,
      size: params.file.size,
      mtimeMs: params.file.mtimeMs,
      anchorHash: snapshotAnchorHash,
      ...(visibleLeafId ? { visibleLeafId } : {}),
    },
    scannedAt: Date.now(),
    parsedRecords:
      (appendOnly ? (params.previous?.entry.parsedRecords ?? 0) : 0) + counts.parsedRecords,
    countedRecords:
      (appendOnly ? (params.previous?.entry.countedRecords ?? 0) : 0) + counts.countedRecords,
    rollup,
  };
}

async function scanUsageFileForRollup(params: {
  file: UsageCostTranscriptFile;
  previous?: UsageCostStoredRollup;
  pricingFingerprint: string;
  resolveCost: UsageCostResolver;
}): Promise<UsageCostRollupEntry> {
  return params.file.kind === "sqlite"
    ? await scanSqliteUsageRollup(params)
    : await scanJsonlUsageRollup(params);
}

async function refreshCostUsageCacheForAgent(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  databasePath?: string;
  maxFiles?: number;
  sessionsDir?: string;
  sessionFiles?: string[];
  startMs?: number;
}): Promise<UsageCostRefreshResult> {
  const databasePath = params?.databasePath ?? resolveUsageCostCacheDatabasePath(params?.agentId);
  const lock = acquireSessionCostUsageRefreshLock(params?.agentId, databasePath);
  if (!lock.acquired) {
    return "busy";
  }
  try {
    const agentDir = params?.agentDir ?? resolveUsageCostAgentDir(params?.config, params?.agentId);
    const pricingFingerprint = resolveUsageCostPricingFingerprint(params?.config, agentDir);
    const rows = readSessionCostUsageRollupRows(params?.agentId, databasePath);
    const rawValues = new Map(rows.map((row) => [row.key, row.valueJson]));
    const rollups = readUsageCostRollups(params?.agentId, pricingFingerprint, databasePath);
    const discoveredFiles = await listUsageCountedTranscriptFiles(
      params?.agentId,
      params?.sessionsDir ? { sessionsDir: params.sessionsDir } : undefined,
    );
    const requestedFiles: UsageCostTranscriptFile[] = [];
    for (const requested of params?.sessionFiles ?? []) {
      const resolved = await resolveUsageCostTranscriptFile(requested);
      if (resolved) {
        requestedFiles.push(resolved);
      }
    }
    const filesByPath = new Map(discoveredFiles.map((file) => [file.filePath, file]));
    for (const file of requestedFiles) {
      filesByPath.set(file.filePath, file);
    }
    const files = [...filesByPath.values()];
    deleteSessionCostUsageRollupsExcept({
      agentId: params?.agentId,
      databasePath,
      liveKeys: new Set(files.map((file) => file.filePath)),
    });

    const requestedPaths = new Set<string>();
    for (const file of requestedFiles) {
      requestedPaths.add(file.filePath);
    }
    const refreshFiles =
      requestedPaths.size > 0
        ? files.filter((file) => requestedPaths.has(file.filePath))
        : params?.startMs === undefined
          ? files
          : files.filter((file) => file.mtimeMs >= params.startMs!);
    const maxFiles =
      params?.maxFiles !== undefined && Number.isFinite(params.maxFiles) && params.maxFiles > 0
        ? Math.floor(params.maxFiles)
        : undefined;
    const staleFiles = getUsageCostStaleRollupFiles({ rollups, files: refreshFiles })
      .toSorted((a, b) => a.size - b.size || a.filePath.localeCompare(b.filePath))
      .slice(0, maxFiles);
    const resolveCost = createUsageCostResolver({ config: params?.config, agentDir });

    for (const file of staleFiles) {
      const previous = rollups.get(file.filePath);
      const entry = await scanUsageFileForRollup({
        file,
        previous,
        pricingFingerprint,
        resolveCost,
      });
      const valueJson = JSON.stringify(entry);
      const written = writeSessionCostUsageRollup({
        agentId: params?.agentId,
        databasePath,
        rollupId: file.filePath,
        previousValueJson: rawValues.get(file.filePath) ?? null,
        valueJson,
        updatedAt: entry.scannedAt,
      });
      if (!written) {
        throw new Error(`usage rollup changed while refreshing: ${file.filePath}`);
      }
      rollups.set(file.filePath, { entry, valueJson });
      rawValues.set(file.filePath, valueJson);
    }
    return "refreshed";
  } finally {
    lock.release();
  }
}

const usageCostRefreshRuntime = { refreshCostUsageCacheForAgent };

async function refreshCostUsageCache(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  maxFiles?: number;
  sessionFiles?: string[];
  startMs?: number;
}): Promise<UsageCostRefreshResult> {
  return await refreshCostUsageCacheForAgent(params);
}

export async function loadCostUsageSummaryFromCache(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId?: string;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<CostUsageSummary> {
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  let rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath);
  let files = await listUsageCountedTranscriptFiles(params.agentId);
  const staleFiles = getUsageCostStaleRollupFiles({ rollups, files });
  if (params.requestRefresh !== false && staleFiles.length > 0) {
    const cachedFiles = countUsableUsageCostRollups({ rollups, files });
    if (params.refreshMode === "sync-when-empty" && cachedFiles === 0) {
      const result = await refreshCostUsageCache({
        config: params.config,
        agentId: params.agentId,
        agentDir,
        startMs: params.startMs,
      });
      rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath);
      files = await listUsageCountedTranscriptFiles(params.agentId);
      if (result === "refreshed" && getUsageCostStaleRollupFiles({ rollups, files }).length > 0) {
        requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
      }
    } else {
      requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
    }
  }
  return buildCostUsageSummaryFromRollups({
    rollups,
    files,
    startMs: params.startMs,
    endMs: params.endMs,
    dayBucket: params.dayBucket,
    refreshing:
      usageCostRefreshes.has(databasePath) ||
      isSessionCostUsageRefreshRunning(params.agentId, databasePath),
  });
}

export async function loadSessionCostSummariesFromCache(params: {
  sessions: Array<{ sessionId?: string; sessionFile: string }>;
  config?: OpenClawConfig;
  agentId?: string;
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  requestRefresh?: boolean;
}): Promise<{ summaries: Array<SessionCostSummary | null>; cacheStatus: UsageCacheStatus }> {
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  const rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath);
  const fileTasks = params.sessions.map(
    (session) => async () => await resolveUsageCostTranscriptFile(session.sessionFile),
  );
  const { results: files } = await runTasksWithConcurrency({
    tasks: fileTasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  const staleFiles = new Set<string>();
  let cachedFiles = 0;
  const hasExplicitRange = params.startMs !== undefined || params.endMs !== undefined;
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  const dayFormatter = createUsageDayKeyFormatter(params.dayBucket);
  const summaries = params.sessions.map((session, index) => {
    const file = files[index];
    const stored = file ? rollups.get(file.filePath) : undefined;
    if (!file || !stored || !isUsageCostRollupFresh({ stored, file })) {
      staleFiles.add(file?.filePath ?? session.sessionFile);
      return null;
    }
    cachedFiles += 1;
    return buildSessionCostSummaryFromRollup({
      rollup: stored.entry.rollup,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      startMs,
      endMs,
      includeUntimestamped: params.includeUntimestamped === true || !hasExplicitRange,
      formatDay: dayFormatter,
    });
  });
  const refreshRequested = params.requestRefresh !== false && staleFiles.size > 0;
  if (refreshRequested) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      sessionFiles: [...staleFiles],
    });
  }
  const refreshRunning = isSessionCostUsageRefreshRunning(params.agentId, databasePath);
  return {
    summaries,
    cacheStatus: {
      status:
        staleFiles.size === 0
          ? "fresh"
          : refreshRunning || refreshRequested
            ? "refreshing"
            : cachedFiles > 0
              ? "partial"
              : "stale",
      cachedFiles,
      pendingFiles: staleFiles.size,
      staleFiles: staleFiles.size,
      refreshedAt: latestUsageCostRollupScan(rollups),
    },
  };
}

function requestCostUsageCacheRefresh(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionFiles?: string[];
}): void {
  const databasePath = resolveUsageCostCacheDatabasePath(params?.agentId);
  const refreshKey = databasePath;
  const existing = usageCostRefreshes.get(refreshKey);
  if (existing) {
    mergeUsageCostRefreshRequest(existing, params);
    return;
  }

  const state: UsageCostRefreshState = {
    agentId: params?.agentId,
    config: params?.config,
    databasePath,
    fullRefreshRequested: false,
    pendingSessionFiles: new Set(),
    running: false,
    sessionsDir: resolveSessionTranscriptsDirForAgent(params?.agentId),
    busyRetryDelayMs: USAGE_COST_REFRESH_RETRY_MIN_MS,
  };
  mergeUsageCostRefreshRequest(state, params);
  usageCostRefreshes.set(refreshKey, state);
  scheduleUsageCostRefresh(refreshKey, state);
}

function mergeUsageCostRefreshRequest(
  state: UsageCostRefreshState,
  params?: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionFiles?: string[];
  },
): void {
  if (params?.config) {
    state.config = params.config;
  }
  if (params?.agentId) {
    state.agentId = params.agentId;
  }
  if (!params?.sessionFiles) {
    state.fullRefreshRequested = true;
    return;
  }
  for (const sessionFile of params.sessionFiles) {
    state.pendingSessionFiles.add(sessionFile);
  }
}

function scheduleUsageCostRefresh(
  refreshKey: string,
  state: UsageCostRefreshState,
  delayMs = 0,
): void {
  if (state.running || state.timer) {
    return;
  }
  const timer = setTimeout(() => {
    state.timer = undefined;
    void runQueuedUsageCostRefresh(refreshKey, state);
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

async function runQueuedUsageCostRefresh(
  refreshKey: string,
  state: UsageCostRefreshState,
): Promise<void> {
  state.running = true;
  let retryDelayMs = 0;
  try {
    while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
      const fullRefreshRequested = state.fullRefreshRequested;
      const sessionFiles = fullRefreshRequested ? [] : [...state.pendingSessionFiles];
      if (!fullRefreshRequested) {
        state.pendingSessionFiles.clear();
      }
      state.fullRefreshRequested = false;
      const result = await usageCostRefreshRuntime.refreshCostUsageCacheForAgent({
        config: state.config,
        agentId: state.agentId,
        databasePath: state.databasePath,
        sessionsDir: state.sessionsDir,
        sessionFiles: fullRefreshRequested ? undefined : sessionFiles,
      });
      if (result === "busy") {
        if (fullRefreshRequested) {
          state.fullRefreshRequested = true;
        } else {
          for (const sessionFile of sessionFiles) {
            state.pendingSessionFiles.add(sessionFile);
          }
        }
        retryDelayMs = state.busyRetryDelayMs;
        // Contention among many per-agent refreshes must degrade to polling, not a 20Hz spin.
        state.busyRetryDelayMs = Math.min(
          state.busyRetryDelayMs * 2,
          USAGE_COST_REFRESH_RETRY_MAX_MS,
        );
        break;
      }
      state.busyRetryDelayMs = USAGE_COST_REFRESH_RETRY_MIN_MS;
    }
  } catch (error) {
    logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
  } finally {
    state.running = false;
    if (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
      scheduleUsageCostRefresh(refreshKey, state, retryDelayMs);
    } else {
      usageCostRefreshes.delete(refreshKey);
    }
  }
}

function clearUsageCostRefreshesForTest(): void {
  for (const state of usageCostRefreshes.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }
  usageCostRefreshes.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionCostUsageTestApi")] = {
    requestCostUsageCacheRefresh,
    usageCostRefreshRuntime,
    clearUsageCostRefreshesForTest,
  };
}

/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export async function discoverAllSessions(params?: {
  agentId?: string;
  startMs?: number;
  endMs?: number;
  includeFirstUserMessage?: boolean;
}): Promise<DiscoveredSession[]> {
  const files = await listUsageCountedTranscriptStats(params?.agentId, {
    minMtimeMs: params?.startMs,
  });

  const discovered = new Map<string, DiscoveredSession>();

  for (const file of files) {
    // Do not exclude by endMs: a session can have activity in range even if it continued later.
    const filePath = file.filePath;
    const fileName = path.basename(filePath);
    const sqliteMarker = parseSqliteSessionFileMarker(filePath);

    const sessionId = sqliteMarker?.sessionId ?? parseUsageCountedSessionIdFromFileName(fileName);
    if (!sessionId) {
      continue;
    }
    const isPrimaryTranscript = sqliteMarker ? true : isPrimarySessionTranscriptFileName(fileName);

    // Try to read first user message for label extraction
    let firstUserMessage: string | undefined;
    if (params?.includeFirstUserMessage !== false) {
      try {
        for await (const parsed of readTranscriptRecords(filePath)) {
          try {
            const message = parsed.message as Record<string, unknown> | undefined;
            if (message?.role === "user") {
              const content = message.content;
              if (typeof content === "string") {
                firstUserMessage = truncateUtf16Safe(content, 100);
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (
                    typeof block === "object" &&
                    block &&
                    (block as Record<string, unknown>).type === "text"
                  ) {
                    const text = (block as Record<string, unknown>).text;
                    if (typeof text === "string") {
                      firstUserMessage = truncateUtf16Safe(text, 100);
                    }
                    break;
                  }
                }
              }
              break; // Found first user message
            }
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    const existing = discovered.get(sessionId);
    const existingIsPrimary = existing
      ? isPrimarySessionTranscriptFileName(path.basename(existing.sessionFile))
      : false;
    const shouldReplace =
      !existing ||
      (isPrimaryTranscript && !existingIsPrimary) ||
      (isPrimaryTranscript === existingIsPrimary && file.mtimeMs >= existing.mtime);

    if (shouldReplace) {
      discovered.set(sessionId, {
        sessionId,
        sessionFile: filePath,
        mtime: file.mtimeMs,
        firstUserMessage: firstUserMessage ?? existing?.firstUserMessage,
      });
      continue;
    }

    if (!existing.firstUserMessage && firstUserMessage) {
      existing.firstUserMessage = firstUserMessage;
      discovered.set(sessionId, existing);
    }
  }

  // Sort by mtime descending (most recent first)
  return Array.from(discovered.values()).toSorted((a, b) => b.mtime - a.mtime);
}

export async function loadSessionCostSummary(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId?: string;
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
}): Promise<SessionCostSummary | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  const file = await resolveUsageCostTranscriptFile(sessionFile);
  if (!file) {
    return null;
  }
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  while (
    (await refreshCostUsageCacheForAgent({
      config: params.config,
      agentId: params.agentId,
      agentDir,
      databasePath,
      sessionFiles: [sessionFile],
    })) === "busy"
  ) {
    // Direct detail callers require the requested session, unlike background
    // summary refreshes. Wait for the agent-wide writer to release, then retry.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, USAGE_COST_DIRECT_REFRESH_RETRY_MS);
    });
  }
  const currentFile = await resolveUsageCostTranscriptFile(sessionFile);
  if (!currentFile) {
    return null;
  }
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  const stored = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath).get(
    currentFile.filePath,
  );
  if (!stored || !isUsageCostRollupFresh({ stored, file: currentFile })) {
    return null;
  }
  const hasExplicitRange = params.startMs !== undefined || params.endMs !== undefined;
  return buildSessionCostSummaryFromRollup({
    rollup: stored.entry.rollup,
    sessionId: params.sessionId,
    sessionFile,
    startMs: params.startMs ?? Number.NEGATIVE_INFINITY,
    endMs: params.endMs ?? Number.POSITIVE_INFINITY,
    includeUntimestamped: params.includeUntimestamped === true || !hasExplicitRange,
    formatDay: createUsageDayKeyFormatter(params.dayBucket),
  });
}

export async function loadSessionUsageTimeSeries(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId?: string;
  maxPoints?: number;
}): Promise<SessionUsageTimeSeries | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  if (!parseSqliteSessionFileMarker(sessionFile) && !fs.existsSync(sessionFile)) {
    return null;
  }

  if (params.maxPoints !== undefined && params.maxPoints !== null) {
    if (!Number.isFinite(params.maxPoints) || params.maxPoints <= 0) {
      return { sessionId: params.sessionId, points: [] };
    }
  }

  const points: Array<Omit<SessionUsageTimePoint, "cumulativeTokens" | "cumulativeCost">> = [];
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

  await scanUsageFile({
    filePath: sessionFile,
    config: params.config,
    resolveCost,
    onEntry: (entry) => {
      const ts = entry.timestamp?.getTime();
      if (!ts) {
        return;
      }

      const { input, output, cacheRead, cacheWrite, totalTokens } = computeUsageTokenTotals(
        entry.usage,
      );
      const cost = entry.costTotal ?? 0;

      points.push({
        timestamp: ts,
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost,
      });
    },
  });

  // Sort by timestamp
  let cumulativeTokens = 0;
  let cumulativeCost = 0;
  const sortedPoints: SessionUsageTimePoint[] = points
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map((point) => {
      cumulativeTokens += point.totalTokens;
      cumulativeCost += point.cost;
      return Object.assign(point, { cumulativeTokens, cumulativeCost });
    });

  // Optionally downsample if too many points
  const maxPoints = params.maxPoints ?? 100;
  if (sortedPoints.length > maxPoints) {
    const step = Math.ceil(sortedPoints.length / maxPoints);
    const downsampled: SessionUsageTimePoint[] = [];
    let downsampledCumulativeTokens = 0;
    let downsampledCumulativeCost = 0;
    for (let i = 0; i < sortedPoints.length; i += step) {
      const bucket = sortedPoints.slice(i, i + step);
      const bucketLast = bucket[bucket.length - 1];
      if (!bucketLast) {
        continue;
      }

      let bucketInput = 0;
      let bucketOutput = 0;
      let bucketCacheRead = 0;
      let bucketCacheWrite = 0;
      let bucketTotalTokens = 0;
      let bucketCost = 0;
      for (const point of bucket) {
        bucketInput += point.input;
        bucketOutput += point.output;
        bucketCacheRead += point.cacheRead;
        bucketCacheWrite += point.cacheWrite;
        bucketTotalTokens += point.totalTokens;
        bucketCost += point.cost;
      }

      downsampledCumulativeTokens += bucketTotalTokens;
      downsampledCumulativeCost += bucketCost;

      downsampled.push({
        timestamp: bucketLast.timestamp,
        input: bucketInput,
        output: bucketOutput,
        cacheRead: bucketCacheRead,
        cacheWrite: bucketCacheWrite,
        totalTokens: bucketTotalTokens,
        cost: bucketCost,
        cumulativeTokens: downsampledCumulativeTokens,
        cumulativeCost: downsampledCumulativeCost,
      });
    }
    return { sessionId: params.sessionId, points: downsampled };
  }

  return { sessionId: params.sessionId, points: sortedPoints };
}

export async function loadSessionLogs(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  config?: OpenClawConfig;
  agentId?: string;
  limit?: number;
}): Promise<SessionLogEntry[] | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile) {
    return null;
  }
  if (!parseSqliteSessionFileMarker(sessionFile) && !fs.existsSync(sessionFile)) {
    return null;
  }

  const logs: SessionLogEntry[] = [];
  if (params.limit !== undefined && params.limit !== null) {
    if (!Number.isFinite(params.limit) || params.limit <= 0) {
      return [];
    }
  }
  const limit = params.limit ?? 50;
  const boundedLimit = Number.isInteger(limit);
  const retentionLimit = limit * 2;
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const resolveCost = createUsageCostResolver({ config: params.config, agentDir });

  for await (const parsed of readTranscriptRecordsBestEffort(sessionFile)) {
    try {
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message) {
        continue;
      }

      const role = message.role as string | undefined;
      if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "toolResult") {
        continue;
      }

      const contentParts: string[] = [];
      const rawToolName = message.toolName ?? message.tool_name ?? message.name ?? message.tool;
      const toolName = normalizeOptionalString(rawToolName);
      if (role === "tool" || role === "toolResult") {
        contentParts.push(`[Tool: ${toolName ?? "tool"}]`);
        contentParts.push("[Tool Result]");
      }

      // Extract content
      const rawContent = message.content;
      if (typeof rawContent === "string") {
        contentParts.push(rawContent);
      } else if (Array.isArray(rawContent)) {
        // Handle content blocks (text, tool_use, etc.)
        const contentText = rawContent
          .map((block: unknown) => {
            if (typeof block === "string") {
              return block;
            }
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              return b.text;
            }
            if (b.type === "tool_use") {
              const name = typeof b.name === "string" ? b.name : "unknown";
              return `[Tool: ${name}]`;
            }
            if (b.type === "tool_result") {
              return `[Tool Result]`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (contentText) {
          contentParts.push(contentText);
        }
      }

      // OpenAI-style tool calls stored outside the content array.
      const rawToolCalls =
        message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
      const toolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls
        : rawToolCalls
          ? [rawToolCalls]
          : [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const callObj = call as Record<string, unknown>;
          const directName = typeof callObj.name === "string" ? callObj.name : undefined;
          const fn = callObj.function as Record<string, unknown> | undefined;
          const fnName = typeof fn?.name === "string" ? fn.name : undefined;
          const name = directName ?? fnName ?? "unknown";
          contentParts.push(`[Tool: ${name}]`);
        }
      }

      let content = contentParts.join("\n").trim();
      if (!content) {
        continue;
      }
      content = stripInboundMetadata(content);
      if (role === "user") {
        content = stripMessageIdHints(stripEnvelope(content)).trim();
      }
      if (!content) {
        continue;
      }

      // Truncate very long content.
      const maxLen = 2000;
      if (content.length > maxLen) {
        content = truncateUtf16Safe(content, maxLen) + "…";
      }

      // Get timestamp
      // Keep detail logs on the usage-summary timestamp path, including nested
      // fallback; direct Date parsing can leak NaN as null through Gateway JSON.
      const timestamp = parseTimestamp(parsed)?.getTime() ?? 0;

      // Get usage for assistant messages
      let tokens: number | undefined;
      let cost: number | undefined;
      if (role === "assistant") {
        const usageRaw = message.usage as Record<string, unknown> | undefined;
        const usage = normalizeUsage(usageRaw);
        if (usage) {
          tokens =
            usage.total ??
            (usage.input ?? 0) +
              (usage.output ?? 0) +
              (usage.cacheRead ?? 0) +
              (usage.cacheWrite ?? 0);
          const breakdown = extractCostBreakdown(usageRaw);
          const costConfig = resolveCost({
            provider:
              (typeof message.provider === "string" ? message.provider : undefined) ??
              (typeof parsed.provider === "string" ? parsed.provider : undefined),
            model:
              (typeof message.model === "string" ? message.model : undefined) ??
              (typeof parsed.model === "string" ? parsed.model : undefined),
          });
          if (
            breakdown?.total !== undefined &&
            !shouldRecomputeRecordedZeroCost({
              usage,
              cost: costConfig,
              costBreakdown: breakdown,
              costTotal: breakdown.total,
            })
          ) {
            cost = breakdown.total;
          } else {
            cost = estimateUsageCost({ usage, cost: costConfig });
          }
        }
      }

      logs.push({
        timestamp,
        role,
        content,
        tokens,
        cost,
      });
      // Timestamps can arrive out of order, so keep a bounded sorted window instead
      // of relying on transcript append order or retaining the whole file.
      if (boundedLimit && logs.length > retentionLimit) {
        logs.sort((a, b) => a.timestamp - b.timestamp);
        logs.splice(0, logs.length - limit);
      }
    } catch {
      // Ignore malformed lines
    }
  }

  // Sort by timestamp and limit
  if (boundedLimit) {
    logs.sort((a, b) => a.timestamp - b.timestamp);
    return logs.length > limit ? logs.slice(-limit) : logs;
  }

  // Return most recent logs
  const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);
  if (sortedLogs.length > limit) {
    return sortedLogs.slice(-limit);
  }

  return sortedLogs;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
