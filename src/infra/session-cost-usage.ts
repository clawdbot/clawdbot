import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { NormalizedUsage, UsageLike } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import {
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseSessionArchiveTimestamp,
  parseUsageCountedSessionIdFromFileName,
} from "../config/sessions/artifacts.js";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { asFiniteNumber } from "../shared/number-coercion.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { countToolResults, extractToolCallNames } from "../utils/transcript-tools.js";
import {
  estimateUsageCost,
  resolveModelCostConfig,
  resolveModelCostConfigFingerprint,
} from "../utils/usage-format.js";
import { formatErrorMessage } from "./errors.js";
import { replaceFileAtomic } from "./replace-file.js";
import type {
  CostBreakdown,
  CostUsageTotals,
  CostUsageSummary,
  DiscoveredSession,
  ParsedTranscriptEntry,
  ParsedUsageEntry,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyMessageCounts,
  SessionDailyModelUsage,
  SessionDailyUsage,
  SessionLatencyStats,
  SessionLogEntry,
  SessionMessageCounts,
  SessionModelUsage,
  SessionUtcQuarterHourMessageCounts,
  SessionUtcQuarterHourTokenUsage,
  SessionToolUsage,
  SessionUsageTimePoint,
  SessionUsageTimeSeries,
  UsageCacheStatus,
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
} from "./session-cost-usage.types.js";

const emptyTotals = (): CostUsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
});

const USAGE_COST_CACHE_VERSION = 2;
const USAGE_COST_CACHE_FILE = ".usage-cost-cache.json";
const USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS = 10_000;
const logger = createSubsystemLogger("usage-cost-cache");

type UsageCostRefreshState = {
  agentId?: string;
  config?: OpenClawConfig;
  fullRefreshRequested: boolean;
  pendingSessionFiles: Set<string>;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

type UsageCostRefreshResult = "refreshed" | "busy";

const usageCostRefreshes = new Map<string, UsageCostRefreshState>();

type UsageCostCachedUsageEntry = CostUsageTotals & { timestamp: number };

type UsageCostCacheFileEntry = {
  filePath: string;
  size: number;
  mtimeMs: number;
  pricingFingerprint: string;
  scannedAt: number;
  parsedRecords: number;
  countedRecords: number;
  usageEntries: UsageCostCachedUsageEntry[];
  totals: CostUsageTotals;
  sessionId?: string;
  sessionSummary?: SessionCostSummary;
};

type UsageCostCacheFile = {
  version: number;
  updatedAt: number;
  files: Record<string, UsageCostCacheFileEntry>;
};

type UsageCostTranscriptFile = {
  filePath: string;
  size: number;
  mtimeMs: number;
};

type UsageCostCacheLock = {
  pid: number;
  startedAt: number;
  token?: string;
};

type UsageCostCacheLockReadResult =
  | { state: "missing" }
  | { state: "valid"; lock: UsageCostCacheLock }
  | { state: "malformed"; mtimeMs: number };

const cloneTotals = (totals: CostUsageTotals): CostUsageTotals => ({
  input: totals.input,
  output: totals.output,
  cacheRead: totals.cacheRead,
  cacheWrite: totals.cacheWrite,
  totalTokens: totals.totalTokens,
  totalCost: totals.totalCost,
  inputCost: totals.inputCost,
  outputCost: totals.outputCost,
  cacheReadCost: totals.cacheReadCost,
  cacheWriteCost: totals.cacheWriteCost,
  missingCostEntries: totals.missingCostEntries,
});

const addTotals = (target: CostUsageTotals, source: CostUsageTotals): void => {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheReadCost += source.cacheReadCost;
  target.cacheWriteCost += source.cacheWriteCost;
  target.missingCostEntries += source.missingCostEntries;
};

function resolveUsageCostPricingFingerprint(config?: OpenClawConfig): string {
  return resolveModelCostConfigFingerprint(config);
}

function resolveUsageCostCachePath(agentId?: string): string {
  return path.join(resolveSessionTranscriptsDirForAgent(agentId), USAGE_COST_CACHE_FILE);
}

function resolveUsageCostCacheLockPath(cachePath: string): string {
  return `${cachePath}.lock`;
}

function parseUsageCostCacheLock(raw: string): UsageCostCacheLock | null {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const lock = parsed as Partial<UsageCostCacheLock>;
  if (
    typeof lock.pid !== "number" ||
    !Number.isInteger(lock.pid) ||
    lock.pid <= 0 ||
    typeof lock.startedAt !== "number" ||
    !Number.isFinite(lock.startedAt) ||
    (lock.token !== undefined && typeof lock.token !== "string")
  ) {
    return null;
  }
  return { pid: lock.pid, startedAt: lock.startedAt, token: lock.token };
}

async function readUsageCostCacheLockState(
  lockPath: string,
): Promise<UsageCostCacheLockReadResult> {
  try {
    const lock = parseUsageCostCacheLock(await fs.promises.readFile(lockPath, "utf-8"));
    if (lock) {
      return { state: "valid", lock };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
  }
  const stats = await fs.promises.stat(lockPath).catch(() => null);
  if (!stats) {
    return { state: "missing" };
  }
  return { state: "malformed", mtimeMs: stats.mtimeMs };
}

async function readUsageCostCacheLock(lockPath: string): Promise<UsageCostCacheLock | null> {
  const result = await readUsageCostCacheLockState(lockPath);
  return result.state === "valid" ? result.lock : null;
}

function isMalformedUsageCostCacheLockRecent(mtimeMs: number): boolean {
  return Date.now() - mtimeMs < USAGE_COST_CACHE_LOCK_WRITE_GRACE_MS;
}

async function writeUsageCostCacheLockAtomically(
  lockPath: string,
  lock: UsageCostCacheLock,
): Promise<void> {
  const tempPath = `${lockPath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(lock)}\n`, { flag: "wx" });
  try {
    await fs.promises.link(tempPath, lockPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function isUsageCostCacheRefreshRunning(cachePath: string): Promise<boolean> {
  const lockPath = resolveUsageCostCacheLockPath(cachePath);
  const result = await readUsageCostCacheLockState(lockPath);
  if (result.state === "missing") {
    return false;
  }
  if (result.state === "malformed") {
    if (isMalformedUsageCostCacheLockRecent(result.mtimeMs)) {
      return true;
    }
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    return false;
  }
  const lock = result.lock;
  if (isProcessRunning(lock.pid)) {
    return true;
  }
  await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
  return false;
}

async function acquireUsageCostCacheRefreshLock(cachePath: string): Promise<{
  acquired: boolean;
  release: () => Promise<void>;
}> {
  const lockPath = resolveUsageCostCacheLockPath(cachePath);
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const lock: UsageCostCacheLock = {
    pid: process.pid,
    startedAt: Date.now(),
    token: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  try {
    await writeUsageCostCacheLockAtomically(lockPath, lock);
    return {
      acquired: true,
      release: async () => {
        const current = await readUsageCostCacheLock(lockPath);
        if (
          current?.pid === lock.pid &&
          current.startedAt === lock.startedAt &&
          current.token === lock.token
        ) {
          await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
        }
      },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw err;
    }
    if (await isUsageCostCacheRefreshRunning(cachePath)) {
      return { acquired: false, release: async () => undefined };
    }
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
    return acquireUsageCostCacheRefreshLock(cachePath);
  }
}

function normalizeUsageCostCache(raw: unknown): UsageCostCacheFile {
  if (!raw || typeof raw !== "object") {
    return { version: USAGE_COST_CACHE_VERSION, updatedAt: 0, files: {} };
  }
  const record = raw as Record<string, unknown>;
  if (
    record.version !== USAGE_COST_CACHE_VERSION ||
    !record.files ||
    typeof record.files !== "object"
  ) {
    return { version: USAGE_COST_CACHE_VERSION, updatedAt: 0, files: {} };
  }
  return {
    version: USAGE_COST_CACHE_VERSION,
    updatedAt: asFiniteNumber(record.updatedAt) ?? 0,
    files: record.files as Record<string, UsageCostCacheFileEntry>,
  };
}

async function readUsageCostCache(cachePath: string): Promise<UsageCostCacheFile> {
  try {
    const raw = await fs.promises.readFile(cachePath, "utf-8");
    return normalizeUsageCostCache(JSON.parse(raw));
  } catch {
    return { version: USAGE_COST_CACHE_VERSION, updatedAt: 0, files: {} };
  }
}

async function writeUsageCostCache(cachePath: string, cache: UsageCostCacheFile): Promise<void> {
  await replaceFileAtomic({
    filePath: cachePath,
    content: `${JSON.stringify(cache)}\n`,
    tempPrefix: ".usage-cost-cache",
  });
}

async function listUsageCountedTranscriptFiles(
  agentId?: string,
): Promise<UsageCostTranscriptFile[]> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name))
      .map(async (entry) => {
        const filePath = path.join(sessionsDir, entry.name);
        const stats = await fs.promises.stat(filePath).catch(() => null);
        if (!stats) {
          return undefined;
        }
        return { filePath, size: stats.size, mtimeMs: stats.mtimeMs };
      }),
  );
  return files.filter((file): file is UsageCostTranscriptFile => Boolean(file));
}

function isUsageCostCacheEntryFresh(params: {
  entry: UsageCostCacheFileEntry | undefined;
  file: UsageCostTranscriptFile;
  pricingFingerprint: string;
  requireSessionSummary?: boolean;
}): boolean {
  return Boolean(
    params.entry &&
    params.entry.size === params.file.size &&
    params.entry.mtimeMs === params.file.mtimeMs &&
    params.entry.pricingFingerprint === params.pricingFingerprint &&
    (!params.requireSessionSummary || params.entry.sessionSummary),
  );
}

function canUseUsageCostCacheEntryForPartial(params: {
  entry: UsageCostCacheFileEntry | undefined;
  file: UsageCostTranscriptFile;
  pricingFingerprint: string;
}): params is {
  entry: UsageCostCacheFileEntry;
  file: UsageCostTranscriptFile;
  pricingFingerprint: string;
} {
  return Boolean(
    params.entry &&
    params.entry.size <= params.file.size &&
    params.entry.mtimeMs <= params.file.mtimeMs &&
    params.entry.pricingFingerprint === params.pricingFingerprint,
  );
}

function getUsageCostStaleFiles(params: {
  cache: UsageCostCacheFile;
  files: UsageCostTranscriptFile[];
  pricingFingerprint: string;
  sessionSummaryFiles?: Set<string>;
}): UsageCostTranscriptFile[] {
  const sessionSummaryFiles = params.sessionSummaryFiles ?? new Set<string>();
  return params.files.filter(
    (file) =>
      !isUsageCostCacheEntryFresh({
        entry: params.cache.files[file.filePath],
        file,
        pricingFingerprint: params.pricingFingerprint,
        requireSessionSummary: sessionSummaryFiles.has(file.filePath),
      }),
  );
}

function countUsableUsageCostCacheFiles(params: {
  cache: UsageCostCacheFile;
  files: UsageCostTranscriptFile[];
  pricingFingerprint: string;
}): number {
  const filesByPath = new Map(params.files.map((file) => [file.filePath, file]));
  let cachedFiles = 0;
  for (const [filePath, entry] of Object.entries(params.cache.files)) {
    const file = filesByPath.get(filePath);
    if (
      file &&
      canUseUsageCostCacheEntryForPartial({
        entry,
        file,
        pricingFingerprint: params.pricingFingerprint,
      })
    ) {
      cachedFiles += 1;
    }
  }
  return cachedFiles;
}

function buildCostUsageSummaryFromCache(params: {
  cache: UsageCostCacheFile;
  files: UsageCostTranscriptFile[];
  startMs: number;
  endMs: number;
  pricingFingerprint: string;
  refreshing: boolean;
}): CostUsageSummary {
  const dailyMap = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();
  const filesByPath = new Map(params.files.map((file) => [file.filePath, file]));
  const staleFiles = getUsageCostStaleFiles({
    cache: params.cache,
    files: params.files,
    pricingFingerprint: params.pricingFingerprint,
  });
  const cachedFiles = countUsableUsageCostCacheFiles({
    cache: params.cache,
    files: params.files,
    pricingFingerprint: params.pricingFingerprint,
  });

  for (const [filePath, entry] of Object.entries(params.cache.files)) {
    const file = filesByPath.get(filePath);
    if (
      !file ||
      !canUseUsageCostCacheEntryForPartial({
        entry,
        file,
        pricingFingerprint: params.pricingFingerprint,
      })
    ) {
      continue;
    }
    for (const usageEntry of entry.usageEntries) {
      if (usageEntry.timestamp < params.startMs || usageEntry.timestamp > params.endMs) {
        continue;
      }
      const date = formatDayKey(new Date(usageEntry.timestamp));
      const bucket = dailyMap.get(date) ?? emptyTotals();
      addTotals(bucket, usageEntry);
      dailyMap.set(date, bucket);
      addTotals(totals, usageEntry);
    }
  }

  const daily = Array.from(dailyMap.entries())
    .map(([date, bucket]) => Object.assign({ date }, bucket))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const days = Math.ceil((params.endMs - params.startMs) / (24 * 60 * 60 * 1000)) + 1;
  const status = params.refreshing
    ? "refreshing"
    : staleFiles.length > 0
      ? cachedFiles > 0
        ? "partial"
        : "stale"
      : "fresh";

  return {
    updatedAt: Date.now(),
    days,
    daily,
    totals,
    cacheStatus: {
      status,
      cachedFiles,
      pendingFiles: staleFiles.length,
      staleFiles: staleFiles.length,
      refreshedAt: params.cache.updatedAt || undefined,
    },
  };
}

function isSessionSummaryContainedInRange(
  summary: SessionCostSummary,
  startMs: number,
  endMs: number,
): boolean {
  return (
    (summary.firstActivity === undefined || summary.firstActivity >= startMs) &&
    (summary.lastActivity === undefined || summary.lastActivity <= endMs)
  );
}

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
  };
};

const parseTimestamp = (entry: Record<string, unknown>): Date | undefined => {
  const raw = entry.timestamp;
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  const message = entry.message as Record<string, unknown> | undefined;
  const messageTimestamp = asFiniteNumber(message?.timestamp);
  if (messageTimestamp !== undefined) {
    const parsed = new Date(messageTimestamp);
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
  if (!role) {
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
    toolNames: extractToolCallNames(message),
    toolResultCounts: countToolResults(message),
  };
};

const formatDayKey = (date: Date): string =>
  date.toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

const formatUtcDayKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const getUtcQuarterHourBucketKey = (
  date: Date,
): { date: string; quarterIndex: number; key: string } => {
  const quarterIndex = Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 15);
  const utcDayKey = formatUtcDayKey(date);
  return { date: utcDayKey, quarterIndex, key: `${utcDayKey}::${quarterIndex}` };
};

/**
 * Accumulate message-level counts into a bucket (daily or UTC quarter-hour).
 * Avoids duplicating the same logic for both daily and quarter-hour message counts.
 */
const accumulateMessageCounts = (
  bucket: {
    total: number;
    user: number;
    assistant: number;
    toolCalls: number;
    toolResults: number;
    errors: number;
  },
  entry: ParsedTranscriptEntry,
  errorStopReasons: Set<string>,
) => {
  bucket.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
  if (entry.role === "user") {
    bucket.user += 1;
  } else if (entry.role === "assistant") {
    bucket.assistant += 1;
  }
  bucket.toolCalls += entry.toolNames.length;
  bucket.toolResults += entry.toolResultCounts.total;
  bucket.errors += entry.toolResultCounts.errors;
  if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
    bucket.errors += 1;
  }
};

const computeLatencyStats = (values: number[]): SessionLatencyStats | undefined => {
  if (!values.length) {
    return undefined;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const count = sorted.length;
  const p95Index = Math.max(0, Math.ceil(count * 0.95) - 1);
  return {
    count,
    avgMs: total / count,
    p95Ms: sorted[p95Index] ?? sorted[count - 1],
    minMs: sorted[0],
    maxMs: sorted[count - 1],
  };
};

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
const applyCostTotal = (totals: CostUsageTotals, costTotal: number | undefined) => {
  if (costTotal === undefined) {
    totals.missingCostEntries += 1;
    return;
  }
  totals.totalCost += costTotal;
};

async function canReadJsonlFromOffset(filePath: string, startOffset: number): Promise<boolean> {
  if (startOffset <= 0) {
    return true;
  }
  const handle = await fs.promises.open(filePath, "r").catch(() => null);
  if (!handle) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(1);
    const result = await handle.read(buffer, 0, 1, startOffset - 1);
    return result.bytesRead === 1 && buffer[0] === 10;
  } finally {
    await handle.close().catch(() => undefined);
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

async function scanTranscriptFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  startOffset?: number;
  endOffset?: number;
  onEntry: (entry: ParsedTranscriptEntry) => void;
}): Promise<void> {
  for await (const parsed of readJsonlRecords(
    params.filePath,
    params.startOffset,
    params.endOffset,
  )) {
    const entry = parseTranscriptEntry(parsed);
    if (!entry) {
      continue;
    }

    if (entry.usage) {
      const cost = resolveModelCostConfig({
        provider: entry.provider,
        model: entry.model,
        config: params.config,
      });
      if (cost?.tieredPricing && cost.tieredPricing.length > 0) {
        // When tiered pricing is configured, always recompute to override
        // the flat-rate cost that the transport layer wrote into the transcript.
        // Clear costBreakdown so downstream aggregation uses the recomputed total
        // instead of the stale flat-rate breakdown from the transport layer.
        entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
        entry.costBreakdown = undefined;
      } else if (entry.costTotal === undefined) {
        // Fill in missing cost estimates.
        entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
      }
    }

    params.onEntry(entry);
  }
}

async function scanUsageFile(params: {
  filePath: string;
  config?: OpenClawConfig;
  startOffset?: number;
  endOffset?: number;
  onEntry: (entry: ParsedUsageEntry) => void;
}): Promise<void> {
  await scanTranscriptFile({
    filePath: params.filePath,
    config: params.config,
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
  const candidate =
    params.sessionFile ??
    (params.sessionId
      ? resolveSessionFilePath(params.sessionId, params.sessionEntry, {
          agentId: params.agentId,
        })
      : undefined);

  if (candidate && fs.existsSync(candidate)) {
    return candidate;
  }

  const sessionId = params.sessionId?.trim();
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
  /** @deprecated Use startMs/endMs. */
  days?: number;
  config?: OpenClawConfig;
  agentId?: string;
}): Promise<CostUsageSummary> {
  const now = new Date();
  let sinceTime: number;
  let untilTime: number;

  if (params?.startMs !== undefined && params?.endMs !== undefined) {
    sinceTime = params.startMs;
    untilTime = params.endMs;
  } else {
    // Fallback to days-based calculation for backwards compatibility
    const days = Math.max(1, Math.floor(params?.days ?? 30));
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    sinceTime = since.getTime();
    untilTime = now.getTime();
  }

  const dailyMap = new Map<string, CostUsageTotals>();
  const totals = emptyTotals();

  const sessionsDir = resolveSessionTranscriptsDirForAgent(params?.agentId);
  const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const files = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isUsageCountedSessionTranscriptFileName(entry.name))
        .map(async (entry) => {
          const filePath = path.join(sessionsDir, entry.name);
          const stats = await fs.promises.stat(filePath).catch(() => null);
          if (!stats) {
            return null;
          }
          // Include file if it was modified after our start time
          if (stats.mtimeMs < sinceTime) {
            return null;
          }
          return filePath;
        }),
    )
  ).filter((filePath): filePath is string => Boolean(filePath));

  for (const filePath of files) {
    await scanUsageFile({
      filePath,
      config: params?.config,
      onEntry: (entry) => {
        const ts = entry.timestamp?.getTime();
        if (!ts || ts < sinceTime || ts > untilTime) {
          return;
        }
        const dayKey = formatDayKey(entry.timestamp ?? now);
        const bucket = dailyMap.get(dayKey) ?? emptyTotals();
        applyUsageTotals(bucket, entry.usage);
        if (entry.costBreakdown?.total !== undefined) {
          applyCostBreakdown(bucket, entry.costBreakdown);
        } else {
          applyCostTotal(bucket, entry.costTotal);
        }
        dailyMap.set(dayKey, bucket);

        applyUsageTotals(totals, entry.usage);
        if (entry.costBreakdown?.total !== undefined) {
          applyCostBreakdown(totals, entry.costBreakdown);
        } else {
          applyCostTotal(totals, entry.costTotal);
        }
      },
    });
  }

  const daily = Array.from(dailyMap.entries())
    .map(([date, bucket]) => Object.assign({ date }, bucket))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  // Calculate days for backwards compatibility in response
  const days = Math.ceil((untilTime - sinceTime) / (24 * 60 * 60 * 1000)) + 1;

  return {
    updatedAt: Date.now(),
    days,
    daily,
    totals,
  };
}

async function scanUsageFileForCache(params: {
  file: UsageCostTranscriptFile;
  config?: OpenClawConfig;
  previous?: UsageCostCacheFileEntry;
  includeSessionSummary?: boolean;
}): Promise<UsageCostCacheFileEntry> {
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  const appendOnlyPrevious =
    params.previous &&
    params.previous.filePath === params.file.filePath &&
    params.previous.size > 0 &&
    params.previous.size < params.file.size &&
    params.previous.pricingFingerprint === pricingFingerprint &&
    params.previous.mtimeMs <= params.file.mtimeMs
      ? params.previous
      : undefined;
  const totals = emptyTotals();
  const usageEntries: UsageCostCachedUsageEntry[] = [];
  let parsedRecords = 0;
  let countedRecords = 0;
  const startOffset =
    appendOnlyPrevious &&
    (await canReadJsonlFromOffset(params.file.filePath, appendOnlyPrevious.size))
      ? appendOnlyPrevious.size
      : undefined;

  await scanUsageFile({
    filePath: params.file.filePath,
    config: params.config,
    startOffset,
    endOffset: params.file.size,
    onEntry: (entry) => {
      parsedRecords += 1;
      const ts = entry.timestamp?.getTime();
      if (!ts) {
        return;
      }
      countedRecords += 1;
      const entryTotals = emptyTotals();
      applyUsageTotals(entryTotals, entry.usage);
      if (entry.costBreakdown?.total !== undefined) {
        applyCostBreakdown(entryTotals, entry.costBreakdown);
      } else {
        applyCostTotal(entryTotals, entry.costTotal);
      }
      usageEntries.push(Object.assign({ timestamp: ts }, entryTotals));

      addTotals(totals, entryTotals);
    },
  });

  const sessionId =
    parseUsageCountedSessionIdFromFileName(path.basename(params.file.filePath)) ?? undefined;
  const sessionSummary = params.includeSessionSummary
    ? ((await loadSessionCostSummary({
        sessionId,
        sessionFile: params.file.filePath,
        config: params.config,
      })) ?? undefined)
    : undefined;

  if (appendOnlyPrevious && startOffset !== undefined) {
    const previousTotals = cloneTotals(appendOnlyPrevious.totals);
    addTotals(previousTotals, totals);
    return {
      ...appendOnlyPrevious,
      size: params.file.size,
      mtimeMs: params.file.mtimeMs,
      pricingFingerprint,
      scannedAt: Date.now(),
      parsedRecords: appendOnlyPrevious.parsedRecords + parsedRecords,
      countedRecords: appendOnlyPrevious.countedRecords + countedRecords,
      usageEntries: [...appendOnlyPrevious.usageEntries, ...usageEntries],
      totals: previousTotals,
      sessionSummary,
    };
  }

  return {
    filePath: params.file.filePath,
    size: params.file.size,
    mtimeMs: params.file.mtimeMs,
    pricingFingerprint,
    scannedAt: Date.now(),
    parsedRecords,
    countedRecords,
    usageEntries,
    totals,
    sessionId,
    sessionSummary,
  };
}

export async function refreshCostUsageCache(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  maxFiles?: number;
  sessionFiles?: string[];
  startMs?: number;
}): Promise<UsageCostRefreshResult> {
  const cachePath = resolveUsageCostCachePath(params?.agentId);
  const lock = await acquireUsageCostCacheRefreshLock(cachePath);
  if (!lock.acquired) {
    return "busy";
  }
  try {
    const pricingFingerprint = resolveUsageCostPricingFingerprint(params?.config);
    const cache = await readUsageCostCache(cachePath);
    const files = await listUsageCountedTranscriptFiles(params?.agentId);
    const sessionSummaryFiles = new Set(params?.sessionFiles ?? []);
    const refreshStartMs = params?.startMs;
    const refreshFiles =
      sessionSummaryFiles.size > 0
        ? files.filter((file) => sessionSummaryFiles.has(file.filePath))
        : refreshStartMs === undefined
          ? files
          : files.filter((file) => file.mtimeMs >= refreshStartMs);
    const livePaths = new Set(files.map((file) => file.filePath));
    for (const filePath of Object.keys(cache.files)) {
      if (!livePaths.has(filePath)) {
        delete cache.files[filePath];
      }
    }

    const maxFiles =
      params?.maxFiles !== undefined && Number.isFinite(params.maxFiles) && params.maxFiles > 0
        ? Math.floor(params.maxFiles)
        : undefined;
    const staleFiles = getUsageCostStaleFiles({
      cache,
      files: refreshFiles,
      pricingFingerprint,
      sessionSummaryFiles,
    })
      .toSorted((a, b) => {
        const aSession = sessionSummaryFiles.has(a.filePath) ? 0 : 1;
        const bSession = sessionSummaryFiles.has(b.filePath) ? 0 : 1;
        return aSession - bSession || a.size - b.size || a.filePath.localeCompare(b.filePath);
      })
      .slice(0, maxFiles);

    for (const file of staleFiles) {
      cache.files[file.filePath] = await scanUsageFileForCache({
        file,
        config: params?.config,
        previous: cache.files[file.filePath],
        includeSessionSummary: sessionSummaryFiles.has(file.filePath),
      });
      cache.updatedAt = Date.now();
      await writeUsageCostCache(cachePath, cache);
    }

    cache.updatedAt = Date.now();
    await writeUsageCostCache(cachePath, cache);
    return "refreshed";
  } finally {
    await lock.release();
  }
}

export async function loadCostUsageSummaryFromCache(params: {
  startMs: number;
  endMs: number;
  config?: OpenClawConfig;
  agentId?: string;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<CostUsageSummary> {
  const cachePath = resolveUsageCostCachePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  let [cache, files] = await Promise.all([
    readUsageCostCache(cachePath),
    listUsageCountedTranscriptFiles(params.agentId),
  ]);
  const staleFiles = getUsageCostStaleFiles({
    cache,
    files,
    pricingFingerprint,
  });
  if (params.requestRefresh !== false && staleFiles.length > 0) {
    const cachedFiles = countUsableUsageCostCacheFiles({
      cache,
      files,
      pricingFingerprint,
    });
    if (params.refreshMode === "sync-when-empty" && cachedFiles === 0) {
      const result = await refreshCostUsageCache({
        config: params.config,
        agentId: params.agentId,
        startMs: params.startMs,
      });
      [cache, files] = await Promise.all([
        readUsageCostCache(cachePath),
        listUsageCountedTranscriptFiles(params.agentId),
      ]);
      if (result === "refreshed") {
        const remainingStaleFiles = getUsageCostStaleFiles({
          cache,
          files,
          pricingFingerprint,
        });
        if (remainingStaleFiles.length > 0) {
          requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
        }
      }
    } else {
      requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
    }
  }
  const refreshRunning = await isUsageCostCacheRefreshRunning(cachePath);
  return buildCostUsageSummaryFromCache({
    cache,
    files,
    startMs: params.startMs,
    endMs: params.endMs,
    pricingFingerprint,
    refreshing: usageCostRefreshes.has(params.agentId ?? "main") || refreshRunning,
  });
}

export async function loadSessionCostSummaryFromCache(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile: string;
  config?: OpenClawConfig;
  agentId?: string;
  startMs?: number;
  endMs?: number;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<{ summary: SessionCostSummary | null; cacheStatus: UsageCacheStatus }> {
  const cachePath = resolveUsageCostCachePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config);
  let [cache, stats] = await Promise.all([
    readUsageCostCache(cachePath),
    fs.promises.stat(params.sessionFile).catch(() => null),
  ]);
  let file = stats
    ? { filePath: params.sessionFile, size: stats.size, mtimeMs: stats.mtimeMs }
    : undefined;
  let entry = cache.files[params.sessionFile];
  let stale =
    !file ||
    !isUsageCostCacheEntryFresh({
      entry,
      file,
      pricingFingerprint,
      requireSessionSummary: true,
    });
  if (params.requestRefresh !== false && stale) {
    if (params.refreshMode === "sync-when-empty") {
      const result = await refreshCostUsageCache({
        config: params.config,
        agentId: params.agentId,
        sessionFiles: [params.sessionFile],
      });
      if (result === "refreshed") {
        [cache, stats] = await Promise.all([
          readUsageCostCache(cachePath),
          fs.promises.stat(params.sessionFile).catch(() => null),
        ]);
        file = stats
          ? { filePath: params.sessionFile, size: stats.size, mtimeMs: stats.mtimeMs }
          : undefined;
        entry = cache.files[params.sessionFile];
        stale =
          !file ||
          !isUsageCostCacheEntryFresh({
            entry,
            file,
            pricingFingerprint,
            requireSessionSummary: true,
          });
      } else {
        requestCostUsageCacheRefresh({
          config: params.config,
          agentId: params.agentId,
          sessionFiles: [params.sessionFile],
        });
      }
    } else {
      requestCostUsageCacheRefresh({
        config: params.config,
        agentId: params.agentId,
        sessionFiles: [params.sessionFile],
      });
    }
  }
  const refreshRunning = await isUsageCostCacheRefreshRunning(cachePath);
  let summary = stale ? null : (entry?.sessionSummary ?? null);
  if (!summary && params.refreshMode === "sync-when-empty") {
    summary = await loadSessionCostSummary({
      sessionId: params.sessionId,
      sessionEntry: params.sessionEntry,
      sessionFile: params.sessionFile,
      config: params.config,
      agentId: params.agentId,
      startMs: params.startMs,
      endMs: params.endMs,
    });
  }
  if (
    summary &&
    params.startMs !== undefined &&
    params.endMs !== undefined &&
    !isSessionSummaryContainedInRange(summary, params.startMs, params.endMs)
  ) {
    summary = await loadSessionCostSummary({
      sessionId: params.sessionId,
      sessionEntry: params.sessionEntry,
      sessionFile: params.sessionFile,
      config: params.config,
      agentId: params.agentId,
      startMs: params.startMs,
      endMs: params.endMs,
    });
  }
  return {
    summary,
    cacheStatus: {
      status: stale ? (refreshRunning ? "refreshing" : summary ? "partial" : "stale") : "fresh",
      cachedFiles: stale ? 0 : 1,
      pendingFiles: stale ? 1 : 0,
      staleFiles: stale ? 1 : 0,
      refreshedAt: cache.updatedAt || undefined,
    },
  };
}

export function requestCostUsageCacheRefresh(params?: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionFiles?: string[];
}): void {
  const agentId = params?.agentId ?? "main";
  const existing = usageCostRefreshes.get(agentId);
  if (existing) {
    mergeUsageCostRefreshRequest(existing, params);
    return;
  }

  const state: UsageCostRefreshState = {
    agentId: params?.agentId,
    config: params?.config,
    fullRefreshRequested: false,
    pendingSessionFiles: new Set(),
    running: false,
  };
  mergeUsageCostRefreshRequest(state, params);
  usageCostRefreshes.set(agentId, state);
  scheduleUsageCostRefresh(agentId, state);
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
  agentId: string,
  state: UsageCostRefreshState,
  delayMs = 0,
): void {
  if (state.running || state.timer) {
    return;
  }
  const timer = setTimeout(() => {
    state.timer = undefined;
    void runQueuedUsageCostRefresh(agentId, state);
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

async function runQueuedUsageCostRefresh(
  agentId: string,
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
      const result = await refreshCostUsageCache({
        config: state.config,
        agentId: state.agentId,
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
        retryDelayMs = 50;
        break;
      }
    }
  } catch (error) {
    logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
  } finally {
    state.running = false;
    if (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
      scheduleUsageCostRefresh(agentId, state, retryDelayMs);
    } else {
      usageCostRefreshes.delete(agentId);
    }
  }
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
  const sessionsDir = resolveSessionTranscriptsDirForAgent(params?.agentId);
  const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);

  const discovered = new Map<string, DiscoveredSession>();

  for (const entry of entries) {
    if (!entry.isFile() || !isUsageCountedSessionTranscriptFileName(entry.name)) {
      continue;
    }

    const filePath = path.join(sessionsDir, entry.name);
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats) {
      continue;
    }

    // Filter by date range if provided
    if (params?.startMs && stats.mtimeMs < params.startMs) {
      continue;
    }
    // Do not exclude by endMs: a session can have activity in range even if it continued later.

    const sessionId = parseUsageCountedSessionIdFromFileName(entry.name);
    if (!sessionId) {
      continue;
    }
    const isPrimaryTranscript = isPrimarySessionTranscriptFileName(entry.name);

    // Try to read first user message for label extraction
    let firstUserMessage: string | undefined;
    if (params?.includeFirstUserMessage !== false) {
      try {
        for await (const parsed of readJsonlRecords(filePath)) {
          try {
            const message = parsed.message as Record<string, unknown> | undefined;
            if (message?.role === "user") {
              const content = message.content;
              if (typeof content === "string") {
                firstUserMessage = content.slice(0, 100);
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (
                    typeof block === "object" &&
                    block &&
                    (block as Record<string, unknown>).type === "text"
                  ) {
                    const text = (block as Record<string, unknown>).text;
                    if (typeof text === "string") {
                      firstUserMessage = text.slice(0, 100);
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
      (isPrimaryTranscript === existingIsPrimary && stats.mtimeMs >= existing.mtime);

    if (shouldReplace) {
      discovered.set(sessionId, {
        sessionId,
        sessionFile: filePath,
        mtime: stats.mtimeMs,
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
}): Promise<SessionCostSummary | null> {
  const sessionFile = resolveExistingUsageSessionFile(params);
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  const totals = emptyTotals();
  let firstActivity: number | undefined;
  let lastActivity: number | undefined;
  const activityDatesSet = new Set<string>();
  const dailyMap = new Map<string, { tokens: number; cost: number }>();
  const dailyMessageMap = new Map<string, SessionDailyMessageCounts>();
  const utcQuarterHourMessageMap = new Map<string, SessionUtcQuarterHourMessageCounts>();
  const utcQuarterHourTokenMap = new Map<string, SessionUtcQuarterHourTokenUsage>();
  const dailyLatencyMap = new Map<string, number[]>();
  const dailyModelUsageMap = new Map<string, SessionDailyModelUsage>();
  const messageCounts: SessionMessageCounts = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const toolUsageMap = new Map<string, number>();
  const modelUsageMap = new Map<string, SessionModelUsage>();
  const errorStopReasons = new Set(["error", "aborted", "timeout"]);
  const latencyValues: number[] = [];
  let lastUserTimestamp: number | undefined;
  const MAX_LATENCY_MS = 12 * 60 * 60 * 1000;

  await scanTranscriptFile({
    filePath: sessionFile,
    config: params.config,
    onEntry: (entry) => {
      const ts = entry.timestamp?.getTime();

      // Filter by date range if specified
      if (params.startMs !== undefined && ts !== undefined && ts < params.startMs) {
        return;
      }
      if (params.endMs !== undefined && ts !== undefined && ts > params.endMs) {
        return;
      }

      if (ts !== undefined) {
        if (!firstActivity || ts < firstActivity) {
          firstActivity = ts;
        }
        if (!lastActivity || ts > lastActivity) {
          lastActivity = ts;
        }
      }

      if (entry.role === "user") {
        messageCounts.user += 1;
        messageCounts.total += 1;
        if (entry.timestamp) {
          lastUserTimestamp = entry.timestamp.getTime();
        }
      }
      if (entry.role === "assistant") {
        messageCounts.assistant += 1;
        messageCounts.total += 1;
        const ts = entry.timestamp?.getTime();
        if (ts !== undefined) {
          const latencyMs =
            entry.durationMs ??
            (lastUserTimestamp !== undefined ? Math.max(0, ts - lastUserTimestamp) : undefined);
          if (
            latencyMs !== undefined &&
            Number.isFinite(latencyMs) &&
            latencyMs <= MAX_LATENCY_MS
          ) {
            latencyValues.push(latencyMs);
            const dayKey = formatDayKey(entry.timestamp ?? new Date(ts));
            const dailyLatencies = dailyLatencyMap.get(dayKey) ?? [];
            dailyLatencies.push(latencyMs);
            dailyLatencyMap.set(dayKey, dailyLatencies);
          }
        }
      }

      if (entry.toolNames.length > 0) {
        messageCounts.toolCalls += entry.toolNames.length;
        for (const name of entry.toolNames) {
          toolUsageMap.set(name, (toolUsageMap.get(name) ?? 0) + 1);
        }
      }

      if (entry.toolResultCounts.total > 0) {
        messageCounts.toolResults += entry.toolResultCounts.total;
        messageCounts.errors += entry.toolResultCounts.errors;
      }

      if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
        messageCounts.errors += 1;
      }

      if (entry.timestamp) {
        const dayKey = formatDayKey(entry.timestamp);
        activityDatesSet.add(dayKey);
        const daily = dailyMessageMap.get(dayKey) ?? {
          date: dayKey,
          total: 0,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        };
        accumulateMessageCounts(daily, entry, errorStopReasons);
        dailyMessageMap.set(dayKey, daily);

        // Per-quarter-hour message counts for precise hourly stats (UTC-based)
        const quarterBucket = getUtcQuarterHourBucketKey(entry.timestamp);
        const utcQuarterHour = utcQuarterHourMessageMap.get(quarterBucket.key) ?? {
          date: quarterBucket.date,
          quarterIndex: quarterBucket.quarterIndex,
          total: 0,
          user: 0,
          assistant: 0,
          toolCalls: 0,
          toolResults: 0,
          errors: 0,
        };
        accumulateMessageCounts(utcQuarterHour, entry, errorStopReasons);
        utcQuarterHourMessageMap.set(quarterBucket.key, utcQuarterHour);
      }

      if (!entry.usage) {
        return;
      }

      applyUsageTotals(totals, entry.usage);
      if (entry.costBreakdown?.total !== undefined) {
        applyCostBreakdown(totals, entry.costBreakdown);
      } else {
        applyCostTotal(totals, entry.costTotal);
      }

      if (entry.timestamp) {
        const dayKey = formatDayKey(entry.timestamp);
        const entryTokenTotals = computeUsageTokenTotals(entry.usage);
        // Preserve the legacy dailyBreakdown token basis until daily metrics are
        // refactored separately. The precise quarter-hour bucket below uses
        // entryTokenTotals.totalTokens so Usage Mosaic matches session totals.
        const entryTokens = entryTokenTotals.componentTotal;
        const entryCost =
          entry.costBreakdown?.total ??
          (entry.costBreakdown
            ? (entry.costBreakdown.input ?? 0) +
              (entry.costBreakdown.output ?? 0) +
              (entry.costBreakdown.cacheRead ?? 0) +
              (entry.costBreakdown.cacheWrite ?? 0)
            : (entry.costTotal ?? 0));

        const quarterBucket = getUtcQuarterHourBucketKey(entry.timestamp);
        const utcQuarterHourToken = utcQuarterHourTokenMap.get(quarterBucket.key) ?? {
          date: quarterBucket.date,
          quarterIndex: quarterBucket.quarterIndex,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          totalCost: 0,
        };
        utcQuarterHourToken.input += entryTokenTotals.input;
        utcQuarterHourToken.output += entryTokenTotals.output;
        utcQuarterHourToken.cacheRead += entryTokenTotals.cacheRead;
        utcQuarterHourToken.cacheWrite += entryTokenTotals.cacheWrite;
        utcQuarterHourToken.totalTokens += entryTokenTotals.totalTokens;
        utcQuarterHourToken.totalCost += entryCost;
        utcQuarterHourTokenMap.set(quarterBucket.key, utcQuarterHourToken);

        const existing = dailyMap.get(dayKey) ?? { tokens: 0, cost: 0 };
        dailyMap.set(dayKey, {
          tokens: existing.tokens + entryTokens,
          cost: existing.cost + entryCost,
        });

        if (entry.provider || entry.model) {
          const modelKey = `${dayKey}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
          const dailyModel =
            dailyModelUsageMap.get(modelKey) ??
            ({
              date: dayKey,
              provider: entry.provider,
              model: entry.model,
              tokens: 0,
              cost: 0,
              count: 0,
            } as SessionDailyModelUsage);
          dailyModel.tokens += entryTokens;
          dailyModel.cost += entryCost;
          dailyModel.count += 1;
          dailyModelUsageMap.set(modelKey, dailyModel);
        }
      }

      if (entry.provider || entry.model) {
        const key = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
        const existing =
          modelUsageMap.get(key) ??
          ({
            provider: entry.provider,
            model: entry.model,
            count: 0,
            totals: emptyTotals(),
          } as SessionModelUsage);
        existing.count += 1;
        applyUsageTotals(existing.totals, entry.usage);
        if (entry.costBreakdown?.total !== undefined) {
          applyCostBreakdown(existing.totals, entry.costBreakdown);
        } else {
          applyCostTotal(existing.totals, entry.costTotal);
        }
        modelUsageMap.set(key, existing);
      }
    },
  });

  // Convert daily map to sorted array
  const dailyBreakdown: SessionDailyUsage[] = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, tokens: data.tokens, cost: data.cost }))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const dailyMessageCounts: SessionDailyMessageCounts[] = Array.from(
    dailyMessageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date));

  const utcQuarterHourMessageCounts: SessionUtcQuarterHourMessageCounts[] = Array.from(
    utcQuarterHourMessageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);

  const utcQuarterHourTokenUsage: SessionUtcQuarterHourTokenUsage[] = Array.from(
    utcQuarterHourTokenMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex);

  const dailyLatency: SessionDailyLatency[] = Array.from(dailyLatencyMap.entries())
    .map(([date, values]) => {
      const stats = computeLatencyStats(values);
      if (!stats) {
        return null;
      }
      return Object.assign({ date }, stats);
    })
    .filter((entry): entry is SessionDailyLatency => Boolean(entry))
    .toSorted((a, b) => a.date.localeCompare(b.date));

  const dailyModelUsage: SessionDailyModelUsage[] = Array.from(
    dailyModelUsageMap.values(),
  ).toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost);

  const toolUsage: SessionToolUsage | undefined = toolUsageMap.size
    ? {
        totalCalls: Array.from(toolUsageMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolUsageMap.size,
        tools: Array.from(toolUsageMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      }
    : undefined;

  const modelUsage = modelUsageMap.size
    ? Array.from(modelUsageMap.values()).toSorted((a, b) => {
        const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
        if (costDiff !== 0) {
          return costDiff;
        }
        return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
      })
    : undefined;

  return {
    sessionId: params.sessionId,
    sessionFile,
    firstActivity,
    lastActivity,
    durationMs:
      firstActivity !== undefined && lastActivity !== undefined
        ? Math.max(0, lastActivity - firstActivity)
        : undefined,
    activityDates: Array.from(activityDatesSet).toSorted(),
    dailyBreakdown,
    dailyMessageCounts,
    utcQuarterHourMessageCounts: utcQuarterHourMessageCounts.length
      ? utcQuarterHourMessageCounts
      : undefined,
    utcQuarterHourTokenUsage: utcQuarterHourTokenUsage.length
      ? utcQuarterHourTokenUsage
      : undefined,
    dailyLatency: dailyLatency.length ? dailyLatency : undefined,
    dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : undefined,
    messageCounts,
    toolUsage,
    modelUsage,
    latency: computeLatencyStats(latencyValues),
    ...totals,
  };
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
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  const points: SessionUsageTimePoint[] = [];
  let cumulativeTokens = 0;
  let cumulativeCost = 0;

  await scanUsageFile({
    filePath: sessionFile,
    config: params.config,
    onEntry: (entry) => {
      const ts = entry.timestamp?.getTime();
      if (!ts) {
        return;
      }

      const { input, output, cacheRead, cacheWrite, totalTokens } = computeUsageTokenTotals(
        entry.usage,
      );
      const cost = entry.costTotal ?? 0;

      cumulativeTokens += totalTokens;
      cumulativeCost += cost;

      points.push({
        timestamp: ts,
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost,
        cumulativeTokens,
        cumulativeCost,
      });
    },
  });

  // Sort by timestamp
  const sortedPoints = points.toSorted((a, b) => a.timestamp - b.timestamp);

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
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  const logs: SessionLogEntry[] = [];
  const limit = params.limit ?? 50;

  for await (const parsed of readJsonlRecords(sessionFile)) {
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

      // Truncate very long content
      const maxLen = 2000;
      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + "…";
      }

      // Get timestamp
      let timestamp = 0;
      if (typeof parsed.timestamp === "string") {
        timestamp = new Date(parsed.timestamp).getTime();
      } else if (typeof message.timestamp === "number") {
        timestamp = message.timestamp;
      }

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
          if (breakdown?.total !== undefined) {
            cost = breakdown.total;
          } else {
            const costConfig = resolveModelCostConfig({
              provider: message.provider as string | undefined,
              model: message.model as string | undefined,
              config: params.config,
            });
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
    } catch {
      // Ignore malformed lines
    }
  }

  // Sort by timestamp and limit
  const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);

  // Return most recent logs
  if (sortedLogs.length > limit) {
    return sortedLogs.slice(-limit);
  }

  return sortedLogs;
}
