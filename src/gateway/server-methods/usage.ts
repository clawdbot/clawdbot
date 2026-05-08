import fs from "node:fs";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  SessionDailyModelUsage,
  SessionMessageCounts,
  SessionModelUsage,
} from "../../infra/session-cost-usage.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionLogs,
  loadSessionCostSummaryFromCache,
  loadSessionUsageTimeSeries,
  discoverAllSessions,
  resolveExistingUsageSessionFile,
  type DiscoveredSession,
  type UsageCacheStatus,
} from "../../infra/session-cost-usage.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  buildUsageAggregateTail,
  mergeUsageDailyLatency,
  mergeUsageLatency,
} from "../../shared/usage-aggregates.js";
import type {
  SessionUsageEntry,
  SessionsUsageAggregates,
  SessionsUsageResult,
} from "../../shared/usage-types.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsUsageParams,
} from "../protocol/index.js";
import {
  listAgentsForGateway,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
} from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const COST_USAGE_CACHE_TTL_MS = 30_000;
const COST_USAGE_CACHE_MAX = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

type DateRange = { startMs: number; endMs: number };
type DateInterpretation =
  | { mode: "utc" | "gateway" }
  | { mode: "specific"; utcOffsetMinutes: number };

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<string, CostUsageCacheEntry>();

function findCostUsageCacheEvictionKey(): string | undefined {
  for (const [key, entry] of costUsageCache) {
    if (!entry.inFlight) {
      return key;
    }
  }
  return costUsageCache.keys().next().value;
}

// Keep the cache bounded while preserving in-flight request coalescing when a
// settled entry is available to evict.
function setCostUsageCache(cacheKey: string, entry: CostUsageCacheEntry): void {
  if (!costUsageCache.has(cacheKey) && costUsageCache.size >= COST_USAGE_CACHE_MAX) {
    const evictKey = findCostUsageCacheEvictionKey();
    if (evictKey !== undefined) {
      costUsageCache.delete(evictKey);
    }
  }
  costUsageCache.set(cacheKey, entry);
}

function resolveSessionUsageFileOrRespond(
  key: string,
  respond: RespondFn,
  config: OpenClawConfig,
): {
  config: OpenClawConfig;
  entry: SessionEntry | undefined;
  agentId: string | undefined;
  sessionId: string;
  sessionFile: string;
} | null {
  const { entry, storePath } = loadSessionEntry(key);

  // For discovered sessions (not in store), try using key as sessionId directly
  const parsed = parseAgentSessionKey(key);
  const agentId = parsed?.agentId;
  const rawSessionId = parsed?.rest ?? key;
  const sessionId = entry?.sessionId ?? rawSessionId;
  let sessionFile: string;
  try {
    const pathOpts = resolveSessionFilePathOptions({ storePath, agentId });
    sessionFile = resolveSessionFilePath(sessionId, entry, pathOpts);
  } catch {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
    );
    return null;
  }

  return { config, entry, agentId, sessionId, sessionFile };
}

const parseDateParts = (
  raw: unknown,
): { year: number; monthIndex: number; day: number } | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return undefined;
  }
  return { year, monthIndex, day };
};

/**
 * Parse a UTC offset string in the format UTC+H, UTC-H, UTC+HH, UTC-HH, UTC+H:MM, UTC-HH:MM.
 * Returns the UTC offset in minutes (east-positive), or undefined if invalid.
 */
const parseUtcOffsetToMinutes = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }
  if (hours > 14 || (hours === 14 && minutes !== 0)) {
    return undefined;
  }
  const totalMinutes = sign * (hours * 60 + minutes);
  if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) {
    return undefined;
  }
  return totalMinutes;
};

const resolveDateInterpretation = (params: {
  mode?: unknown;
  utcOffset?: unknown;
}): DateInterpretation => {
  if (params.mode === "gateway") {
    return { mode: "gateway" };
  }
  if (params.mode === "specific") {
    const utcOffsetMinutes = parseUtcOffsetToMinutes(params.utcOffset);
    if (utcOffsetMinutes !== undefined) {
      return { mode: "specific", utcOffsetMinutes };
    }
  }
  // Backward compatibility: when mode is missing (or invalid), keep current UTC interpretation.
  return { mode: "utc" };
};

/**
 * Parse a date string (YYYY-MM-DD) to start-of-day timestamp based on interpretation mode.
 * Returns undefined if invalid.
 */
const parseDateToMs = (
  raw: unknown,
  interpretation: DateInterpretation = { mode: "utc" },
): number | undefined => {
  const parts = parseDateParts(raw);
  if (!parts) {
    return undefined;
  }
  const { year, monthIndex, day } = parts;
  if (interpretation.mode === "gateway") {
    const ms = new Date(year, monthIndex, day).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (interpretation.mode === "specific") {
    const ms = Date.UTC(year, monthIndex, day) - interpretation.utcOffsetMinutes * 60 * 1000;
    return Number.isNaN(ms) ? undefined : ms;
  }
  const ms = Date.UTC(year, monthIndex, day);
  return Number.isNaN(ms) ? undefined : ms;
};

const getTodayStartMs = (now: Date, interpretation: DateInterpretation): number => {
  if (interpretation.mode === "gateway") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (interpretation.mode === "specific") {
    const shifted = new Date(now.getTime() + interpretation.utcOffsetMinutes * 60 * 1000);
    return (
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
      interpretation.utcOffsetMinutes * 60 * 1000
    );
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

const parseDays = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
};

const resolveRangeDays = (raw: unknown): number | "all" | undefined => {
  if (raw === "all") {
    return "all";
  }
  if (raw === "7d") {
    return 7;
  }
  if (raw === "30d") {
    return 30;
  }
  if (raw === "90d") {
    return 90;
  }
  if (raw === "1y") {
    return 365;
  }
  return undefined;
};

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
  range?: unknown;
  mode?: unknown;
  utcOffset?: unknown;
}): DateRange => {
  const now = new Date();
  const interpretation = resolveDateInterpretation(params);
  const todayStartMs = getTodayStartMs(now, interpretation);
  const todayEndMs = todayStartMs + DAY_MS - 1;

  const startMs = parseDateToMs(params.startDate, interpretation);
  const endMs = parseDateToMs(params.endDate, interpretation);

  if (startMs !== undefined && endMs !== undefined) {
    // endMs should be end of day
    return { startMs, endMs: endMs + DAY_MS - 1 };
  }

  const rangeDays = resolveRangeDays(params.range);
  if (rangeDays === "all") {
    return { startMs: 0, endMs: todayEndMs };
  }
  if (rangeDays !== undefined) {
    const start = todayStartMs - (rangeDays - 1) * DAY_MS;
    return { startMs: start, endMs: todayEndMs };
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    const start = todayStartMs - (clampedDays - 1) * DAY_MS;
    return { startMs: start, endMs: todayEndMs };
  }

  // Default to last 30 days
  const defaultStartMs = todayStartMs - 29 * DAY_MS;
  return { startMs: defaultStartMs, endMs: todayEndMs };
};

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };
type UsageGroupingMode = "instance" | "family";

type MergedEntry = {
  key: string;
  sessionId: string;
  sessionFile: string;
  label?: string;
  updatedAt: number;
  storeEntry?: SessionEntry;
  firstUserMessage?: string;
  scope?: "instance" | "family";
  sessionFamilyKey?: string;
  currentSessionId?: string;
  includedSessionIds?: string[];
};

function buildStoreBySessionId(
  store: Record<string, SessionEntry>,
): Map<string, { key: string; entry: SessionEntry }> {
  const matchesBySessionId = new Map<string, Array<[string, SessionEntry]>>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const matches = matchesBySessionId.get(entry.sessionId) ?? [];
    matches.push([key, entry]);
    matchesBySessionId.set(entry.sessionId, matches);
  }

  const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
  for (const [sessionId, matches] of matchesBySessionId) {
    const preferredKey = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
    if (!preferredKey) {
      continue;
    }
    const preferredEntry = store[preferredKey];
    if (preferredEntry) {
      storeBySessionId.set(sessionId, { key: preferredKey, entry: preferredEntry });
    }
  }
  return storeBySessionId;
}

async function discoverAllSessionsForUsage(params: {
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const agents = listAgentsForGateway(params.config).agents;
  const results = await Promise.all(
    agents.map(async (agent) => {
      const sessions = await discoverAllSessions({
        agentId: agent.id,
        startMs: params.startMs,
        endMs: params.endMs,
        includeFirstUserMessage: false,
      });
      return sessions.map((session) => Object.assign({}, session, { agentId: agent.id }));
    }),
  );
  return results.flat().toSorted((a, b) => b.mtime - a.mtime);
}

function addUniqueSessionIds(target: string[], ids: Array<string | undefined>): string[] {
  const seen = new Set(target);
  for (const id of ids) {
    const normalized = normalizeOptionalString(id);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      target.push(normalized);
    }
  }
  return target;
}

function resolveUsageFamilySessionIds(entry: SessionEntry | undefined, currentSessionId: string) {
  return addUniqueSessionIds([], [currentSessionId, ...(entry?.usageFamilySessionIds ?? [])]);
}

function resolveUsageFamilyKey(params: {
  key: string;
  entry: SessionEntry | undefined;
  sessionId: string;
}): string {
  return params.entry?.usageFamilyKey ?? params.key ?? params.sessionId;
}

function maybeMergeFamilyEntry(params: {
  mergedEntries: MergedEntry[];
  base: MergedEntry;
  groupingMode: UsageGroupingMode;
}) {
  if (params.groupingMode !== "family") {
    params.mergedEntries.push(params.base);
    return;
  }

  const includedSessionIds = resolveUsageFamilySessionIds(
    params.base.storeEntry,
    params.base.sessionId,
  );
  const sessionFamilyKey = resolveUsageFamilyKey({
    key: params.base.key,
    entry: params.base.storeEntry,
    sessionId: params.base.sessionId,
  });
  params.mergedEntries.push({
    ...params.base,
    scope: "family",
    sessionFamilyKey,
    currentSessionId: params.base.sessionId,
    includedSessionIds,
  });
}

function createEmptySessionCostSummary(): SessionCostSummary {
  return {
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
  };
}

function mergeSessionUsageInto(target: SessionCostSummary, source: SessionCostSummary): void {
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
  target.firstActivity =
    target.firstActivity === undefined
      ? source.firstActivity
      : source.firstActivity === undefined
        ? target.firstActivity
        : Math.min(target.firstActivity, source.firstActivity);
  target.lastActivity =
    target.lastActivity === undefined
      ? source.lastActivity
      : source.lastActivity === undefined
        ? target.lastActivity
        : Math.max(target.lastActivity, source.lastActivity);
  if (target.firstActivity !== undefined && target.lastActivity !== undefined) {
    target.durationMs = Math.max(0, target.lastActivity - target.firstActivity);
  }

  const activityDates = new Set([...(target.activityDates ?? []), ...(source.activityDates ?? [])]);
  if (activityDates.size > 0) {
    target.activityDates = Array.from(activityDates).toSorted();
  }

  target.dailyBreakdown = mergeDailyRows(target.dailyBreakdown, source.dailyBreakdown, [
    "tokens",
    "cost",
  ]);
  target.dailyMessageCounts = mergeDailyRows(target.dailyMessageCounts, source.dailyMessageCounts, [
    "total",
    "user",
    "assistant",
    "toolCalls",
    "toolResults",
    "errors",
  ]);
  target.utcQuarterHourMessageCounts = mergeQuarterRows(
    target.utcQuarterHourMessageCounts,
    source.utcQuarterHourMessageCounts,
    ["total", "user", "assistant", "toolCalls", "toolResults", "errors"],
  );
  target.utcQuarterHourTokenUsage = mergeQuarterRows(
    target.utcQuarterHourTokenUsage,
    source.utcQuarterHourTokenUsage,
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "totalCost"],
  );
  target.dailyLatency = mergeDailyLatencyRows(target.dailyLatency, source.dailyLatency);
  target.dailyModelUsage = mergeDailyModelRows(target.dailyModelUsage, source.dailyModelUsage);
  target.messageCounts = mergeMessageCounts(target.messageCounts, source.messageCounts);
  target.toolUsage = mergeToolUsage(target.toolUsage, source.toolUsage);
  target.modelUsage = mergeModelUsage(target.modelUsage, source.modelUsage);
  target.latency = mergeLatency(target.latency, source.latency);
}

function mergeDailyRows<T extends { date: string }>(
  left: T[] | undefined,
  right: T[] | undefined,
  fields: Array<keyof T>,
): T[] | undefined {
  const map = new Map<string, T>();
  for (const row of [...(left ?? []), ...(right ?? [])]) {
    const existing = map.get(row.date);
    if (!existing) {
      map.set(row.date, { ...row });
      continue;
    }
    for (const field of fields) {
      existing[field] = (((existing[field] as number | undefined) ?? 0) +
        ((row[field] as number | undefined) ?? 0)) as T[keyof T];
    }
  }
  return map.size > 0
    ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date))
    : undefined;
}

function mergeQuarterRows<T extends { date: string; quarterIndex: number }>(
  left: T[] | undefined,
  right: T[] | undefined,
  fields: Array<keyof T>,
): T[] | undefined {
  const map = new Map<string, T>();
  for (const row of [...(left ?? []), ...(right ?? [])]) {
    const key = `${row.date}:${row.quarterIndex}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...row });
      continue;
    }
    for (const field of fields) {
      existing[field] = (((existing[field] as number | undefined) ?? 0) +
        ((row[field] as number | undefined) ?? 0)) as T[keyof T];
    }
  }
  return map.size > 0
    ? Array.from(map.values()).toSorted(
        (a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex,
      )
    : undefined;
}

function mergeMessageCounts(
  left: SessionMessageCounts | undefined,
  right: SessionMessageCounts | undefined,
): SessionMessageCounts | undefined {
  if (!left && !right) {
    return undefined;
  }
  return {
    total: (left?.total ?? 0) + (right?.total ?? 0),
    user: (left?.user ?? 0) + (right?.user ?? 0),
    assistant: (left?.assistant ?? 0) + (right?.assistant ?? 0),
    toolCalls: (left?.toolCalls ?? 0) + (right?.toolCalls ?? 0),
    toolResults: (left?.toolResults ?? 0) + (right?.toolResults ?? 0),
    errors: (left?.errors ?? 0) + (right?.errors ?? 0),
  };
}

function mergeToolUsage(
  left: SessionCostSummary["toolUsage"],
  right: SessionCostSummary["toolUsage"],
): SessionCostSummary["toolUsage"] {
  const map = new Map<string, number>();
  for (const tool of [...(left?.tools ?? []), ...(right?.tools ?? [])]) {
    map.set(tool.name, (map.get(tool.name) ?? 0) + tool.count);
  }
  return map.size > 0
    ? {
        totalCalls: Array.from(map.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: map.size,
        tools: Array.from(map.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      }
    : undefined;
}

function mergeModelUsage(
  left: SessionCostSummary["modelUsage"],
  right: SessionCostSummary["modelUsage"],
): SessionCostSummary["modelUsage"] {
  const map = new Map<string, SessionModelUsage>();
  const mergeTotals = (target: CostUsageSummary["totals"], source: CostUsageSummary["totals"]) => {
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
  for (const entry of [...(left ?? []), ...(right ?? [])]) {
    const key = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
    const existing =
      map.get(key) ??
      ({
        provider: entry.provider,
        model: entry.model,
        count: 0,
        totals: createEmptySessionCostSummary(),
      } as SessionModelUsage);
    existing.count += entry.count;
    mergeTotals(existing.totals, entry.totals);
    map.set(key, existing);
  }
  return map.size > 0 ? Array.from(map.values()) : undefined;
}

function mergeLatency(
  left: SessionCostSummary["latency"],
  right: SessionCostSummary["latency"],
): SessionCostSummary["latency"] {
  if (!left && !right) {
    return undefined;
  }
  const leftCount = left?.count ?? 0;
  const rightCount = right?.count ?? 0;
  const count = leftCount + rightCount;
  return {
    count,
    avgMs:
      count > 0 ? ((left?.avgMs ?? 0) * leftCount + (right?.avgMs ?? 0) * rightCount) / count : 0,
    p95Ms: Math.max(left?.p95Ms ?? 0, right?.p95Ms ?? 0),
    minMs: Math.min(
      left?.minMs ?? Number.POSITIVE_INFINITY,
      right?.minMs ?? Number.POSITIVE_INFINITY,
    ),
    maxMs: Math.max(left?.maxMs ?? 0, right?.maxMs ?? 0),
  };
}

function mergeDailyLatencyRows(
  left: SessionCostSummary["dailyLatency"],
  right: SessionCostSummary["dailyLatency"],
): SessionCostSummary["dailyLatency"] {
  const map = new Map<string, NonNullable<SessionCostSummary["dailyLatency"]>[number]>();
  for (const row of [...(left ?? []), ...(right ?? [])]) {
    const existing = map.get(row.date);
    if (!existing) {
      map.set(row.date, { ...row });
      continue;
    }
    const count = existing.count + row.count;
    existing.avgMs =
      count > 0 ? (existing.avgMs * existing.count + row.avgMs * row.count) / count : 0;
    existing.count = count;
    existing.p95Ms = Math.max(existing.p95Ms, row.p95Ms);
    existing.minMs = Math.min(existing.minMs, row.minMs);
    existing.maxMs = Math.max(existing.maxMs, row.maxMs);
  }
  return map.size > 0
    ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date))
    : undefined;
}

function mergeDailyModelRows(
  left: SessionCostSummary["dailyModelUsage"],
  right: SessionCostSummary["dailyModelUsage"],
): SessionCostSummary["dailyModelUsage"] {
  const map = new Map<string, NonNullable<SessionCostSummary["dailyModelUsage"]>[number]>();
  for (const row of [...(left ?? []), ...(right ?? [])]) {
    const key = `${row.date}:${row.provider ?? "unknown"}:${row.model ?? "unknown"}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...row });
      continue;
    }
    existing.tokens += row.tokens;
    existing.cost += row.cost;
    existing.count += row.count;
  }
  return map.size > 0
    ? Array.from(map.values()).toSorted((a, b) => a.date.localeCompare(b.date))
    : undefined;
}

async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  const cacheKey = `${params.startMs}-${params.endMs}`;
  const now = Date.now();
  const cached = costUsageCache.get(cacheKey);
  if (
    cached?.summary &&
    cached.updatedAt &&
    now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS &&
    cached.summary.cacheStatus?.status !== "refreshing"
  ) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = loadCostUsageSummaryFromCache({
    startMs: params.startMs,
    endMs: params.endMs,
    config: params.config,
    requestRefresh: true,
    refreshMode: "sync-when-empty",
  })
    .then((summary) => {
      setCostUsageCache(cacheKey, {
        summary,
        updatedAt: summary.cacheStatus?.status === "refreshing" ? undefined : Date.now(),
      });
      return summary;
    })
    .catch((err) => {
      if (entry.summary) {
        return entry.summary;
      }
      throw err;
    })
    .finally(() => {
      const current = costUsageCache.get(cacheKey);
      if (current?.inFlight === inFlight) {
        current.inFlight = undefined;
        setCostUsageCache(cacheKey, current);
      }
    });

  entry.inFlight = inFlight;
  setCostUsageCache(cacheKey, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
}

function mergeUsageCacheStatus(
  target: UsageCacheStatus | undefined,
  source: UsageCacheStatus,
): UsageCacheStatus {
  if (!target) {
    return { ...source };
  }
  const statusRank = { fresh: 0, partial: 1, stale: 2, refreshing: 3 } as const;
  return {
    status: statusRank[source.status] > statusRank[target.status] ? source.status : target.status,
    cachedFiles: target.cachedFiles + source.cachedFiles,
    pendingFiles: target.pendingFiles + source.pendingFiles,
    staleFiles: target.staleFiles + source.staleFiles,
    refreshedAt:
      target.refreshedAt === undefined
        ? source.refreshedAt
        : source.refreshedAt === undefined
          ? target.refreshedAt
          : Math.max(target.refreshedAt, source.refreshedAt),
  };
}

// Exposed for unit tests (kept as a single export to avoid widening the public API surface).
export const __test = {
  parseDateParts,
  parseUtcOffsetToMinutes,
  resolveDateInterpretation,
  parseDateToMs,
  getTodayStartMs,
  parseDays,
  parseDateRange,
  discoverAllSessionsForUsage,
  loadCostUsageSummaryCached,
  costUsageCache,
};

export type { SessionUsageEntry, SessionsUsageAggregates, SessionsUsageResult };

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params, context }) => {
    const config = context.getRuntimeConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
      range: params?.range,
      mode: params?.mode,
      utcOffset: params?.utcOffset,
    });
    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params, context }) => {
    if (!validateSessionsUsageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const config = context.getRuntimeConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: p.startDate,
      endDate: p.endDate,
      range: p.range,
      mode: p.mode,
      utcOffset: p.utcOffset,
    });
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = normalizeOptionalString(p.key) ?? null;
    const groupingMode: UsageGroupingMode =
      p.groupBy === "family" || p.includeHistorical === true ? "family" : "instance";

    // Load session store for named sessions
    const { storePath, store } = loadCombinedSessionStoreForGateway(config);
    const now = Date.now();

    const mergedEntries: MergedEntry[] = [];

    // Optimization: If a specific key is requested, skip full directory scan
    if (specificKey) {
      const parsed = parseAgentSessionKey(specificKey);
      const agentIdFromKey = parsed?.agentId;
      const keyRest = parsed?.rest ?? specificKey;

      // Prefer the store entry when available, even if the caller provides a discovered key
      // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
      const storeBySessionId = buildStoreBySessionId(store);

      const storeMatch = store[specificKey]
        ? { key: specificKey, entry: store[specificKey] }
        : null;
      const storeByIdMatch = storeBySessionId.get(keyRest) ?? null;
      const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? specificKey;
      const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
      const sessionId = storeEntry?.sessionId ?? keyRest;

      // Resolve the session file path
      let sessionFile: string | undefined;
      try {
        const pathOpts = resolveSessionFilePathOptions({
          storePath: storePath !== "(multiple)" ? storePath : undefined,
          agentId: agentIdFromKey,
        });
        sessionFile = resolveExistingUsageSessionFile({
          sessionId,
          sessionEntry: storeEntry,
          sessionFile: resolveSessionFilePath(sessionId, storeEntry, pathOpts),
          agentId: agentIdFromKey,
        });
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session reference: ${specificKey}`),
        );
        return;
      }

      if (sessionFile) {
        try {
          const stats = fs.statSync(sessionFile);
          if (stats.isFile()) {
            maybeMergeFamilyEntry({
              mergedEntries,
              groupingMode,
              base: {
                key: resolvedStoreKey,
                sessionId,
                sessionFile,
                label: storeEntry?.label,
                updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
                storeEntry,
              },
            });
          }
        } catch {
          // File doesn't exist - no results for this key
        }
      }
    } else {
      // Full discovery for list view
      const discoveredSessions = await discoverAllSessionsForUsage({
        config,
        startMs,
        endMs,
      });

      // Build a map of sessionId -> store entry for quick lookup
      const storeBySessionId = buildStoreBySessionId(store);
      const storeFamilySessionIds = new Set<string>();
      if (groupingMode === "family") {
        for (const entry of Object.values(store)) {
          for (const sessionId of entry?.usageFamilySessionIds ?? []) {
            storeFamilySessionIds.add(sessionId);
          }
        }
      }

      for (const discovered of discoveredSessions) {
        const storeMatch = storeBySessionId.get(discovered.sessionId);
        if (storeMatch) {
          // Named session from store
          maybeMergeFamilyEntry({
            mergedEntries,
            groupingMode,
            base: {
              key: storeMatch.key,
              sessionId: discovered.sessionId,
              sessionFile: discovered.sessionFile,
              label: storeMatch.entry.label,
              updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
              storeEntry: storeMatch.entry,
            },
          });
        } else {
          if (groupingMode === "family" && storeFamilySessionIds.has(discovered.sessionId)) {
            continue;
          }
          // Unnamed session - use session ID as key, no label
          mergedEntries.push({
            // Keep agentId in the key so the dashboard can attribute sessions and later fetch logs.
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: undefined, // No label for unnamed sessions
            updatedAt: discovered.mtime,
            scope: "instance",
          });
        }
      }
    }

    // Sort by most recent first
    mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

    // Apply limit
    const limitedEntries = mergedEntries.slice(0, limit);

    // Load usage for each session
    const sessions: SessionUsageEntry[] = [];
    const aggregateTotals = {
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
    };
    const aggregateMessages: SessionMessageCounts = {
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
    const toolAggregateMap = new Map<string, number>();
    const byModelMap = new Map<string, SessionModelUsage>();
    const byProviderMap = new Map<string, SessionModelUsage>();
    const byAgentMap = new Map<string, CostUsageSummary["totals"]>();
    const byChannelMap = new Map<string, CostUsageSummary["totals"]>();
    const dailyAggregateMap = new Map<
      string,
      {
        date: string;
        tokens: number;
        cost: number;
        messages: number;
        toolCalls: number;
        errors: number;
      }
    >();
    const latencyTotals = {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      p95Max: 0,
    };
    const dailyLatencyMap = new Map<
      string,
      { date: string; count: number; sum: number; min: number; max: number; p95Max: number }
    >();
    const modelDailyMap = new Map<string, SessionDailyModelUsage>();
    let cacheStatus: UsageCacheStatus | undefined;

    const emptyTotals = (): CostUsageSummary["totals"] => ({
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
    const mergeTotals = (
      target: CostUsageSummary["totals"],
      source: CostUsageSummary["totals"],
    ) => {
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

    for (const merged of limitedEntries) {
      const agentId = parseAgentSessionKey(merged.key)?.agentId;
      let usage: SessionCostSummary | null = null;
      const includedSessionIds = merged.includedSessionIds ?? [merged.sessionId];
      for (const includedSessionId of includedSessionIds) {
        const isCurrentSession = includedSessionId === merged.sessionId;
        const includedSessionFile = isCurrentSession
          ? merged.sessionFile
          : resolveExistingUsageSessionFile({
              sessionId: includedSessionId,
              agentId,
            });
        if (!includedSessionFile) {
          continue;
        }
        const cachedUsage = await loadSessionCostSummaryFromCache({
          sessionId: includedSessionId,
          sessionEntry: isCurrentSession ? merged.storeEntry : undefined,
          sessionFile: includedSessionFile,
          config,
          agentId,
          startMs,
          endMs,
          refreshMode: "sync-when-empty",
        });
        cacheStatus = mergeUsageCacheStatus(cacheStatus, cachedUsage.cacheStatus);
        const includedUsage = cachedUsage.summary;
        if (!includedUsage) {
          continue;
        }
        if (!usage) {
          usage = createEmptySessionCostSummary();
          usage.sessionId = merged.sessionId;
          usage.sessionFile = merged.sessionFile;
        }
        mergeSessionUsageInto(usage, includedUsage);
      }

      if (usage) {
        aggregateTotals.input += usage.input;
        aggregateTotals.output += usage.output;
        aggregateTotals.cacheRead += usage.cacheRead;
        aggregateTotals.cacheWrite += usage.cacheWrite;
        aggregateTotals.totalTokens += usage.totalTokens;
        aggregateTotals.totalCost += usage.totalCost;
        aggregateTotals.inputCost += usage.inputCost;
        aggregateTotals.outputCost += usage.outputCost;
        aggregateTotals.cacheReadCost += usage.cacheReadCost;
        aggregateTotals.cacheWriteCost += usage.cacheWriteCost;
        aggregateTotals.missingCostEntries += usage.missingCostEntries;
      }

      const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
      const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;

      if (usage) {
        if (usage.messageCounts) {
          aggregateMessages.total += usage.messageCounts.total;
          aggregateMessages.user += usage.messageCounts.user;
          aggregateMessages.assistant += usage.messageCounts.assistant;
          aggregateMessages.toolCalls += usage.messageCounts.toolCalls;
          aggregateMessages.toolResults += usage.messageCounts.toolResults;
          aggregateMessages.errors += usage.messageCounts.errors;
        }

        if (usage.toolUsage) {
          for (const tool of usage.toolUsage.tools) {
            toolAggregateMap.set(tool.name, (toolAggregateMap.get(tool.name) ?? 0) + tool.count);
          }
        }

        if (usage.modelUsage) {
          for (const entry of usage.modelUsage) {
            const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
            const modelExisting =
              byModelMap.get(modelKey) ??
              ({
                provider: entry.provider,
                model: entry.model,
                count: 0,
                totals: emptyTotals(),
              } as SessionModelUsage);
            modelExisting.count += entry.count;
            mergeTotals(modelExisting.totals, entry.totals);
            byModelMap.set(modelKey, modelExisting);

            const providerKey = entry.provider ?? "unknown";
            const providerExisting =
              byProviderMap.get(providerKey) ??
              ({
                provider: entry.provider,
                model: undefined,
                count: 0,
                totals: emptyTotals(),
              } as SessionModelUsage);
            providerExisting.count += entry.count;
            mergeTotals(providerExisting.totals, entry.totals);
            byProviderMap.set(providerKey, providerExisting);
          }
        }

        mergeUsageLatency(latencyTotals, usage.latency);
        mergeUsageDailyLatency(dailyLatencyMap, usage.dailyLatency);

        if (usage.dailyModelUsage) {
          for (const entry of usage.dailyModelUsage) {
            const key = `${entry.date}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
            const existing =
              modelDailyMap.get(key) ??
              ({
                date: entry.date,
                provider: entry.provider,
                model: entry.model,
                tokens: 0,
                cost: 0,
                count: 0,
              } as SessionDailyModelUsage);
            existing.tokens += entry.tokens;
            existing.cost += entry.cost;
            existing.count += entry.count;
            modelDailyMap.set(key, existing);
          }
        }

        if (agentId) {
          const agentTotals = byAgentMap.get(agentId) ?? emptyTotals();
          mergeTotals(agentTotals, usage);
          byAgentMap.set(agentId, agentTotals);
        }

        if (channel) {
          const channelTotals = byChannelMap.get(channel) ?? emptyTotals();
          mergeTotals(channelTotals, usage);
          byChannelMap.set(channel, channelTotals);
        }

        if (usage.dailyBreakdown) {
          for (const day of usage.dailyBreakdown) {
            const daily = dailyAggregateMap.get(day.date) ?? {
              date: day.date,
              tokens: 0,
              cost: 0,
              messages: 0,
              toolCalls: 0,
              errors: 0,
            };
            daily.tokens += day.tokens;
            daily.cost += day.cost;
            dailyAggregateMap.set(day.date, daily);
          }
        }

        if (usage.dailyMessageCounts) {
          for (const day of usage.dailyMessageCounts) {
            const daily = dailyAggregateMap.get(day.date) ?? {
              date: day.date,
              tokens: 0,
              cost: 0,
              messages: 0,
              toolCalls: 0,
              errors: 0,
            };
            daily.messages += day.total;
            daily.toolCalls += day.toolCalls;
            daily.errors += day.errors;
            dailyAggregateMap.set(day.date, daily);
          }
        }
      }

      sessions.push({
        key: merged.key,
        label: merged.label,
        sessionId: merged.sessionId,
        scope: merged.scope ?? "instance",
        sessionFamilyKey: merged.sessionFamilyKey,
        currentSessionId: merged.currentSessionId,
        includedSessionIds: merged.includedSessionIds,
        historicalInstanceCount: merged.includedSessionIds?.length,
        updatedAt: merged.updatedAt,
        agentId,
        channel,
        chatType,
        origin: merged.storeEntry?.origin,
        modelOverride: merged.storeEntry?.modelOverride,
        providerOverride: merged.storeEntry?.providerOverride,
        modelProvider: merged.storeEntry?.modelProvider,
        model: merged.storeEntry?.model,
        usage,
        contextWeight: includeContextWeight
          ? (merged.storeEntry?.systemPromptReport ?? null)
          : undefined,
      });
    }

    // Format dates back to YYYY-MM-DD strings
    const formatDateStr = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    const tail = buildUsageAggregateTail({
      byChannelMap: byChannelMap,
      latencyTotals,
      dailyLatencyMap,
      modelDailyMap,
      dailyMap: dailyAggregateMap,
    });

    const aggregates: SessionsUsageAggregates = {
      messages: aggregateMessages,
      tools: {
        totalCalls: Array.from(toolAggregateMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolAggregateMap.size,
        tools: Array.from(toolAggregateMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      },
      byModel: Array.from(byModelMap.values()).toSorted((a, b) => {
        const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
        if (costDiff !== 0) {
          return costDiff;
        }
        return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
      }),
      byProvider: Array.from(byProviderMap.values()).toSorted((a, b) => {
        const costDiff = (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0);
        if (costDiff !== 0) {
          return costDiff;
        }
        return (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0);
      }),
      byAgent: Array.from(byAgentMap.entries())
        .map(([id, totals]) => ({ agentId: id, totals }))
        .toSorted((a, b) => (b.totals?.totalCost ?? 0) - (a.totals?.totalCost ?? 0)),
      ...tail,
    };

    const result: SessionsUsageResult = {
      updatedAt: now,
      startDate: formatDateStr(startMs),
      endDate: formatDateStr(endMs),
      sessions,
      totals: aggregateTotals,
      aggregates,
      cacheStatus,
    };

    respond(true, result, undefined);
  },
  "sessions.usage.timeseries": async ({ respond, params, context }) => {
    const key = normalizeOptionalString(params?.key) ?? null;
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"),
      );
      return;
    }

    const resolved = resolveSessionUsageFileOrRespond(key, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const timeseries = await loadSessionUsageTimeSeries({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      agentId,
      maxPoints: 200,
    });

    if (!timeseries) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${key}`),
      );
      return;
    }

    respond(true, timeseries, undefined);
  },
  "sessions.usage.logs": async ({ respond, params, context }) => {
    const key = normalizeOptionalString(params?.key) ?? null;
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
      return;
    }

    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const resolved = resolveSessionUsageFileOrRespond(key, respond, context.getRuntimeConfig());
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const logs = await loadSessionLogs({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      agentId,
      limit,
    });

    respond(true, { logs: logs ?? [] }, undefined);
  },
};
