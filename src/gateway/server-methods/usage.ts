// Usage gateway methods aggregate provider and session cost/token metrics from
// caches, logs, session stores, and discovered transcript files.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsUsageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createTimeZoneDayKeyFormatter,
  resolveTimezone,
  resolveTimeZoneDayStartMs,
} from "../../infra/format-time/format-datetime.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../infra/session-cost-usage-totals.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
  SessionDailyModelUsage,
  SessionMessageCounts,
  SessionModelUsage,
} from "../../infra/session-cost-usage.js";
import {
  loadCostUsageSummaryFromCache,
  loadSessionLogs,
  loadSessionCostSummariesFromCache,
  loadSessionUsageTimeSeries,
  discoverAllSessions,
  resolveExistingUsageSessionFile,
  type DiscoveredSession,
  type UsageDailyBucket,
  type UsageCacheStatus,
} from "../../infra/session-cost-usage.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
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
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";
import { loadCombinedSessionStoreForGateway, loadSessionEntryReadOnly } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const COST_USAGE_CACHE_TTL_MS = 30_000;
const COST_USAGE_CACHE_MAX = 256;
const USAGE_AGENT_LOAD_CONCURRENCY = 12;

async function runUsageAgentTasks<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const result = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_AGENT_LOAD_CONCURRENCY,
    errorMode: "stop",
  });
  // These fan-outs historically rejected as one unit. Never return partial
  // per-agent usage; successful results retain their input order.
  if (result.hasError) {
    throw result.firstError;
  }
  return result.results;
}

type DateRange = { startMs: number; endMs: number; includeUntimestamped?: boolean };
// Keep validation and parsed timestamps in one result so handlers cannot forward
// an invalid or backwards window to the usage loaders.
type DateRangeResolution = { ok: true; value: DateRange } | { ok: false; error: string };
// 100 years: callers requesting unbounded history should use `range: "all"`.
// Larger explicit day counts would overflow ECMAScript Date arithmetic and
// surface as a misleading "calendar day does not exist" error from the resolver.
const MAX_USAGE_DAYS = 366 * 100;
type DateInterpretation =
  | { mode: "utc" | "gateway" }
  | { mode: "utc-offset"; utcOffsetMinutes: number }
  | { mode: "time-zone"; timeZone: string; formatDayKey: (date: Date) => string };
type DateInterpretationResolution =
  | { ok: true; value: DateInterpretation }
  | { ok: false; error: string };
type DateParts = { year: number; monthIndex: number; day: number };

const MAX_CONSECUTIVE_SKIPPED_TIME_ZONE_DAYS = 1;

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<string, CostUsageCacheEntry>();

function findCostUsageCacheEvictionKey(): string | undefined {
  for (const [key, entry] of costUsageCache) {
    // Prefer evicting settled entries so duplicate callers can still join active loads.
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
  agentId: string;
  sessionId: string;
  sessionFile: string;
} | null {
  const { entry, storePath } = loadSessionEntryReadOnly(key);

  // For discovered sessions (not in store), try using key as sessionId directly
  const parsed = parseAgentSessionKey(key);
  const agentId = parsed?.agentId ?? resolveDefaultAgentId(config);
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

const parseDateParts = (raw: unknown): DateParts | undefined => {
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
  // The regex only checks shape; Date.* silently rolls impossible calendar dates over
  // (e.g. 2026-02-30 -> 2026-03-02), so a typo'd day would return usage for the wrong day.
  // Reject parts that don't round-trip through a UTC probe (also catches the JS 2-digit-year remap).
  const probe = new Date(Date.UTC(year, monthIndex, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthIndex ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, monthIndex, day };
};

const shiftDateParts = (parts: DateParts, days: number): DateParts => {
  const shifted = new Date(Date.UTC(parts.year, parts.monthIndex, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
};

const datePartsToStartMs = (
  parts: DateParts,
  interpretation: DateInterpretation,
): number | undefined => {
  const { year, monthIndex, day } = parts;
  if (interpretation.mode === "gateway") {
    return new Date(year, monthIndex, day).getTime();
  }
  if (interpretation.mode === "time-zone") {
    return resolveTimeZoneDayStartMs(
      formatDateParts(year, monthIndex, day),
      interpretation.timeZone,
    );
  }
  if (interpretation.mode === "utc-offset") {
    return Date.UTC(year, monthIndex, day) - interpretation.utcOffsetMinutes * 60 * 1000;
  }
  return Date.UTC(year, monthIndex, day);
};

const datePartsToEndMs = (
  parts: DateParts,
  interpretation: DateInterpretation,
): number | undefined => {
  const lookaheadDays =
    interpretation.mode === "time-zone" ? 1 + MAX_CONSECUTIVE_SKIPPED_TIME_ZONE_DAYS : 1;
  // A 24-hour date-line transition can remove one civil date entirely. Range
  // resolution separately verifies the requested day; this only finds its end.
  for (let daysAhead = 1; daysAhead <= lookaheadDays; daysAhead += 1) {
    const nextDayStartMs = datePartsToStartMs(shiftDateParts(parts, daysAhead), interpretation);
    if (nextDayStartMs !== undefined) {
      return nextDayStartMs - 1;
    }
  }
  return undefined;
};

// usage.cost / sessions.usage accept optional startDate/endDate. parseDateParts returns
// undefined for both absent and invalid input, so an explicitly supplied but unparseable
// date (bad format or impossible calendar date like 2026-02-30) would otherwise silently
// fall through to the default range and return a successful response for an unrelated range.
// Return the offending field so range resolution can reject it instead of querying the wrong window.
const findInvalidExplicitDate = (params: {
  startDate?: unknown;
  endDate?: unknown;
}): "startDate" | "endDate" | undefined => {
  for (const field of ["startDate", "endDate"] as const) {
    const raw = params[field];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      continue;
    }
    if (parseDateParts(raw) === undefined) {
      return field;
    }
  }
  return undefined;
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
  timeZone?: unknown;
}): DateInterpretationResolution => {
  if (params.mode === "gateway") {
    return { ok: true, value: { mode: "gateway" } };
  }
  if (params.mode === "specific") {
    const utcOffsetMinutes = parseUtcOffsetToMinutes(params.utcOffset);
    if (params.timeZone !== undefined && params.timeZone !== null) {
      const requestedTimeZone = normalizeOptionalString(params.timeZone);
      const timeZone = requestedTimeZone ? resolveTimezone(requestedTimeZone) : undefined;
      if (!timeZone) {
        // Browser tzdata can lead Gateway ICU. Preserve legacy fixed-offset
        // reporting when the concurrently supplied offset is still usable.
        if (utcOffsetMinutes !== undefined) {
          return { ok: true, value: { mode: "utc-offset", utcOffsetMinutes } };
        }
        return { ok: false, error: "invalid timeZone: expected a valid IANA time zone" };
      }
      return {
        ok: true,
        value: {
          mode: "time-zone",
          timeZone,
          formatDayKey: createTimeZoneDayKeyFormatter(timeZone),
        },
      };
    }
    if (utcOffsetMinutes !== undefined) {
      return { ok: true, value: { mode: "utc-offset", utcOffsetMinutes } };
    }
  }
  // Backward compatibility: when mode is missing (or invalid), keep current UTC interpretation.
  return { ok: true, value: { mode: "utc" } };
};

const resolveDayBucket = (interpretation: DateInterpretation): UsageDailyBucket | undefined => {
  if (interpretation.mode === "gateway") {
    return undefined;
  }
  if (interpretation.mode === "time-zone") {
    return { mode: "time-zone", timeZone: interpretation.timeZone };
  }
  return {
    mode: "utc-offset",
    utcOffsetMinutes: interpretation.mode === "utc-offset" ? interpretation.utcOffsetMinutes : 0,
  };
};

const getDateParts = (date: Date, interpretation: DateInterpretation): DateParts => {
  if (interpretation.mode === "gateway") {
    return { year: date.getFullYear(), monthIndex: date.getMonth(), day: date.getDate() };
  }
  if (interpretation.mode === "time-zone") {
    const parts = parseDateParts(interpretation.formatDayKey(date));
    if (!parts) {
      throw new Error("timezone formatter returned an invalid calendar day");
    }
    return parts;
  }
  if (interpretation.mode === "utc-offset") {
    const shifted = new Date(date.getTime() + interpretation.utcOffsetMinutes * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      monthIndex: shifted.getUTCMonth(),
      day: shifted.getUTCDate(),
    };
  }
  return {
    year: date.getUTCFullYear(),
    monthIndex: date.getUTCMonth(),
    day: date.getUTCDate(),
  };
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
  return datePartsToStartMs(parts, interpretation);
};

const formatDateLabel = (ms: number, interpretation: DateInterpretation): string => {
  const parts = getDateParts(new Date(ms), interpretation);
  return formatDateParts(parts.year, parts.monthIndex, parts.day);
};

const formatDateParts = (year: number, monthIndex: number, day: number): string =>
  `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const parseDays = (raw: unknown): number | undefined => {
  const fromFinite = (n: number): number | undefined => {
    if (!Number.isFinite(n)) {
      return undefined;
    }
    return Math.min(Math.floor(n), MAX_USAGE_DAYS);
  };
  if (typeof raw === "number") {
    return fromFinite(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return fromFinite(Number(raw));
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

const resolveTrailingDays = (
  endDateParts: DateParts,
  days: number,
  interpretation: DateInterpretation,
): DateRangeResolution => {
  const startMs = datePartsToStartMs(shiftDateParts(endDateParts, -(days - 1)), interpretation);
  const endMs = datePartsToEndMs(endDateParts, interpretation);
  if (startMs === undefined || endMs === undefined) {
    return { ok: false, error: "calendar day does not exist in requested time zone" };
  }
  return { ok: true, value: { startMs, endMs } };
};

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
const resolveDateRange = (
  params: {
    startDate?: unknown;
    endDate?: unknown;
    days?: unknown;
    range?: unknown;
    mode?: unknown;
    utcOffset?: unknown;
    timeZone?: unknown;
  },
  resolvedInterpretation?: DateInterpretation,
): DateRangeResolution => {
  const invalidDate = findInvalidExplicitDate(params);
  if (invalidDate) {
    return {
      ok: false,
      error: `invalid ${invalidDate}: expected a valid YYYY-MM-DD calendar date`,
    };
  }

  const now = new Date();
  const interpretationResolution = resolvedInterpretation
    ? { ok: true as const, value: resolvedInterpretation }
    : resolveDateInterpretation(params);
  if (!interpretationResolution.ok) {
    return interpretationResolution;
  }
  const interpretation = interpretationResolution.value;
  const todayDateParts = getDateParts(now, interpretation);
  const todayEndMs = datePartsToEndMs(todayDateParts, interpretation);
  if (todayEndMs === undefined) {
    return { ok: false, error: "calendar day does not exist in requested time zone" };
  }

  const startDateParts = parseDateParts(params.startDate);
  const endDateParts = parseDateParts(params.endDate);

  if (startDateParts && endDateParts) {
    const startMs = datePartsToStartMs(startDateParts, interpretation);
    const endStartMs = datePartsToStartMs(endDateParts, interpretation);
    const endMs = datePartsToEndMs(endDateParts, interpretation);
    if (startMs === undefined || endStartMs === undefined || endMs === undefined) {
      return { ok: false, error: "calendar day does not exist in requested time zone" };
    }
    if (startMs > endStartMs) {
      return { ok: false, error: "startDate must not be after endDate" };
    }
    return { ok: true, value: { startMs, endMs } };
  }

  const rangeDays = resolveRangeDays(params.range);
  if (rangeDays === "all") {
    return {
      ok: true,
      value: { startMs: 0, endMs: todayEndMs, includeUntimestamped: true },
    };
  }
  if (rangeDays !== undefined) {
    return resolveTrailingDays(todayDateParts, rangeDays, interpretation);
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    return resolveTrailingDays(todayDateParts, clampedDays, interpretation);
  }

  // Default to last 30 days
  return resolveTrailingDays(todayDateParts, 30, interpretation);
};

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };
type UsageGroupingMode = "instance" | "family";

type MergedEntry = {
  key: string;
  agentId: string;
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
    // Multiple store keys can point at one transcript; choose the UI-facing canonical key.
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

function filterSessionStoreByAgent(params: {
  config: OpenClawConfig;
  store: Record<string, SessionEntry>;
  agentId: string;
}): Record<string, SessionEntry> {
  const scopedAgentId = normalizeAgentId(params.agentId);
  const scopedStore: Record<string, SessionEntry> = {};
  for (const [key, entry] of Object.entries(params.store)) {
    if (params.config.session?.scope === "global" && key.trim().toLowerCase() === "global") {
      scopedStore[key] = entry;
      continue;
    }
    if (resolveSessionStoreAgentId(params.config, key) === scopedAgentId) {
      scopedStore[key] = entry;
    }
  }
  return scopedStore;
}

async function discoverAllSessionsForUsage(params: {
  config: OpenClawConfig;
  agentId?: string;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const agents = requestedAgentId
    ? [{ id: normalizeAgentId(requestedAgentId) }]
    : listGatewayAgentsBasic(params.config).agents;
  const discovered = await runUsageAgentTasks(
    agents.map((agent) => async () => {
      const agentId = normalizeAgentId(agent.id);
      const sessions = await discoverAllSessions({
        agentId,
        startMs: params.startMs,
        endMs: params.endMs,
        includeFirstUserMessage: false,
      });
      return sessions.map((session) => Object.assign({}, session, { agentId }));
    }),
  );
  return discovered.flat().toSorted((a, b) => b.mtime - a.mtime);
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
  // Family rows keep historical transcript ids so usage survives session resets.
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
    ...createEmptyCostUsageTotals(),
  };
}

function mergeSessionUsageInto(target: SessionCostSummary, source: SessionCostSummary): void {
  addCostUsageTotals(target, source);
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
    addCostUsageTotals(existing.totals, entry.totals);
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
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
  agentId?: string;
  agentScope?: "all";
}): Promise<CostUsageSummary> {
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.config));
  const dayBucketKey = params.dayBucket
    ? params.dayBucket.mode === "time-zone"
      ? `time-zone:${params.dayBucket.timeZone}`
      : `utc-offset:${params.dayBucket.utcOffsetMinutes}`
    : "gateway";
  const cacheKey = `${params.agentScope === "all" ? "all" : `agent:${agentId}`}:${params.startMs}-${params.endMs}:${dayBucketKey}`;
  const now = Date.now();
  const cached = costUsageCache.get(cacheKey);
  if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = (
    params.agentScope === "all"
      ? loadAllAgentCostUsageSummary({
          startMs: params.startMs,
          endMs: params.endMs,
          dayBucket: params.dayBucket,
          config: params.config,
        })
      : loadCostUsageSummaryFromCache({
          startMs: params.startMs,
          endMs: params.endMs,
          dayBucket: params.dayBucket,
          config: params.config,
          agentId,
          requestRefresh: true,
          refreshMode: "background",
        })
  )
    .then((summary) => {
      // Refresh work is independent; retaining freshness prevents fleet rescans while it runs.
      // The short TTL still picks up a completed refresh promptly.
      setCostUsageCache(cacheKey, {
        summary,
        updatedAt: Date.now(),
      });
      return summary;
    })
    .catch((err: unknown) => {
      if (entry.summary) {
        // Serve the stale summary if background refresh fails; callers asked for usage, not repair.
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

async function loadAllAgentCostUsageSummary(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  const agentIds = listGatewayAgentsBasic(params.config).agents.map((agent) =>
    normalizeAgentId(agent.id),
  );
  const summaries = await runUsageAgentTasks(
    agentIds.map(
      (agentId) => () =>
        loadCostUsageSummaryFromCache({
          startMs: params.startMs,
          endMs: params.endMs,
          dayBucket: params.dayBucket,
          config: params.config,
          agentId,
          requestRefresh: true,
          refreshMode: "background",
        }),
    ),
  );
  const dailyByDate = new Map<string, CostUsageTotals & { date: string }>();
  const totals = createEmptyCostUsageTotals();
  let cacheStatus: UsageCacheStatus | undefined;
  let updatedAt = 0;
  let days = 0;
  for (const summary of summaries) {
    updatedAt = Math.max(updatedAt, summary.updatedAt);
    days = Math.max(days, summary.days);
    addCostUsageTotals(totals, summary.totals);
    if (summary.cacheStatus) {
      cacheStatus = mergeUsageCacheStatus(cacheStatus, summary.cacheStatus);
    }
    for (const day of summary.daily) {
      const entry = dailyByDate.get(day.date) ?? {
        date: day.date,
        ...createEmptyCostUsageTotals(),
      };
      addCostUsageTotals(entry, day);
      dailyByDate.set(day.date, entry);
    }
  }
  return {
    updatedAt,
    days,
    daily: Array.from(dailyByDate.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
    totals,
    ...(cacheStatus ? { cacheStatus } : {}),
  };
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
export const testApi = {
  parseDateParts,
  parseUtcOffsetToMinutes,
  resolveDateInterpretation,
  parseDateToMs,
  parseDays,
  resolveDateRange,
  discoverAllSessionsForUsage,
  loadCostUsageSummaryCached,
  costUsageCache,
};
export { testApi as __test };

export type { SessionUsageEntry, SessionsUsageAggregates, SessionsUsageResult };

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params, context }) => {
    const dateInterpretationResolution = resolveDateInterpretation({
      mode: params?.mode,
      utcOffset: params?.utcOffset,
      timeZone: params?.timeZone,
    });
    if (!dateInterpretationResolution.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, dateInterpretationResolution.error),
      );
      return;
    }
    const dateInterpretation = dateInterpretationResolution.value;
    const dateRange = resolveDateRange(
      {
        startDate: params?.startDate,
        endDate: params?.endDate,
        days: params?.days,
        range: params?.range,
        mode: params?.mode,
        utcOffset: params?.utcOffset,
        timeZone: params?.timeZone,
      },
      dateInterpretation,
    );
    if (!dateRange.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, dateRange.error));
      return;
    }
    const config = context.getRuntimeConfig();
    const { startMs, endMs } = dateRange.value;
    const agentId = normalizeOptionalString(params?.agentId);
    const agentScope = params?.agentScope === "all" && !agentId ? "all" : undefined;
    const summary = await loadCostUsageSummaryCached({
      startMs,
      endMs,
      dayBucket: resolveDayBucket(dateInterpretation),
      config,
      agentId,
      agentScope,
    });
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
    const dateInterpretationResolution = resolveDateInterpretation({
      mode: p.mode,
      utcOffset: p.utcOffset,
      timeZone: p.timeZone,
    });
    if (!dateInterpretationResolution.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, dateInterpretationResolution.error),
      );
      return;
    }
    const dateInterpretation = dateInterpretationResolution.value;
    const dateRange = resolveDateRange(
      {
        startDate: p.startDate,
        endDate: p.endDate,
        range: p.range,
        mode: p.mode,
        utcOffset: p.utcOffset,
        timeZone: p.timeZone,
      },
      dateInterpretation,
    );
    if (!dateRange.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, dateRange.error));
      return;
    }
    const config = context.getRuntimeConfig();
    const { startMs, endMs, includeUntimestamped } = dateRange.value;
    const dayBucket = resolveDayBucket(dateInterpretation);
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = normalizeOptionalString(p.key) ?? null;
    const requestedAgentId = normalizeOptionalString(p.agentId);
    const requestedAllAgents = p.agentScope === "all";
    if (requestedAllAgents && (requestedAgentId || specificKey)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agentScope=all cannot be combined with key or agentId",
        ),
      );
      return;
    }
    const specificKeyAgentId = specificKey ? parseAgentSessionKey(specificKey)?.agentId : undefined;
    if (
      requestedAgentId &&
      specificKeyAgentId &&
      normalizeAgentId(requestedAgentId) !== specificKeyAgentId
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      );
      return;
    }
    const effectiveAgentId = requestedAllAgents
      ? undefined
      : normalizeAgentId(requestedAgentId ?? specificKeyAgentId ?? resolveDefaultAgentId(config));
    const groupingMode: UsageGroupingMode =
      p.groupBy === "family" || p.includeHistorical === true ? "family" : "instance";

    // Load session store for named sessions
    const sessionStoreOpts = effectiveAgentId ? { agentId: effectiveAgentId } : {};
    const { storePath, store } = loadCombinedSessionStoreForGateway(config, sessionStoreOpts);
    const scopedStore = effectiveAgentId
      ? filterSessionStoreByAgent({
          config,
          store,
          agentId: effectiveAgentId,
        })
      : store;
    const now = Date.now();

    const mergedEntries: MergedEntry[] = [];

    // Optimization: If a specific key is requested, skip full directory scan
    if (specificKey) {
      const scopedSpecificKey = resolveStoredSessionKeyForAgentStore({
        cfg: config,
        agentId: effectiveAgentId ?? resolveDefaultAgentId(config),
        sessionKey: specificKey,
      });
      const scopedParsed = parseAgentSessionKey(scopedSpecificKey);
      const agentIdFromKey =
        scopedParsed?.agentId ?? effectiveAgentId ?? resolveDefaultAgentId(config);
      const keyRest = scopedParsed?.rest ?? specificKey;

      // Prefer the store entry when available, even if the caller provides a discovered key
      // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
      const storeBySessionId = buildStoreBySessionId(scopedStore);

      const storeMatch = scopedStore[scopedSpecificKey]
        ? { key: scopedSpecificKey, entry: scopedStore[scopedSpecificKey] }
        : scopedStore[specificKey]
          ? { key: specificKey, entry: scopedStore[specificKey] }
          : null;
      const storeByIdMatch =
        storeBySessionId.get(keyRest) ??
        (keyRest !== specificKey ? storeBySessionId.get(specificKey) : undefined) ??
        null;
      const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? scopedSpecificKey;
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
                agentId: agentIdFromKey,
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
        ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
        startMs,
        endMs,
      });

      // Build a map of sessionId -> store entry for quick lookup
      const storeBySessionId = buildStoreBySessionId(scopedStore);
      const storeFamilySessionIds = new Set<string>();
      if (groupingMode === "family") {
        for (const entry of Object.values(scopedStore)) {
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
              agentId: discovered.agentId,
              sessionId: discovered.sessionId,
              sessionFile: discovered.sessionFile,
              label: storeMatch.entry.label,
              updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
              storeEntry: storeMatch.entry,
            },
          });
        } else {
          if (groupingMode === "family" && storeFamilySessionIds.has(discovered.sessionId)) {
            // The current store row will load this historical transcript through included ids.
            continue;
          }
          // Unnamed session - use session ID as key, no label
          mergedEntries.push({
            // Keep agentId in the key so the dashboard can attribute sessions and later fetch logs.
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            agentId: discovered.agentId,
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

    // Load usage for each session
    const sessions: SessionUsageEntry[] = [];
    const aggregateTotals = createEmptyCostUsageTotals();
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

    const usageByEntryIndex: Array<SessionCostSummary | null> = Array.from(
      { length: mergedEntries.length },
      () => null,
    );

    // Group every included session (visible + hidden) by agent so the usage-cost
    // cache is read and parsed at most once per agent. Loading each session
    // individually re-reads and re-parses the whole cache file, so RSS spikes
    // in proportion to `limit` on every dashboard connect (issue #100041).
    const sessionsByAgent = new Map<
      string,
      Array<{ entryIndex: number; sessionId: string; sessionFile: string }>
    >();
    for (const [entryIndex, merged] of mergedEntries.entries()) {
      for (const includedSessionId of merged.includedSessionIds ?? [merged.sessionId]) {
        const includedSessionFile =
          includedSessionId === merged.sessionId
            ? merged.sessionFile
            : resolveExistingUsageSessionFile({
                sessionId: includedSessionId,
                agentId: merged.agentId,
              });
        if (!includedSessionFile) {
          continue;
        }
        const agentSessions = sessionsByAgent.get(merged.agentId) ?? [];
        agentSessions.push({
          entryIndex,
          sessionId: includedSessionId,
          sessionFile: includedSessionFile,
        });
        sessionsByAgent.set(merged.agentId, agentSessions);
      }
    }

    const agentLoads = await runUsageAgentTasks(
      Array.from(sessionsByAgent.entries()).map(([agentId, agentSessions]) => async () => ({
        agentSessions,
        loaded: await loadSessionCostSummariesFromCache({
          sessions: agentSessions,
          config,
          agentId,
          startMs,
          endMs,
          includeUntimestamped,
          dayBucket,
        }),
      })),
    );
    for (const { agentSessions, loaded } of agentLoads) {
      cacheStatus = mergeUsageCacheStatus(cacheStatus, loaded.cacheStatus);
      for (const [index, summary] of loaded.summaries.entries()) {
        if (!summary) {
          continue;
        }
        const session = expectDefined(agentSessions[index], "agent sessions entry at index");
        const merged = expectDefined(
          mergedEntries[session.entryIndex],
          "merged entries entry at session.entry index",
        );
        const usage = usageByEntryIndex[session.entryIndex] ?? createEmptySessionCostSummary();
        usage.sessionId = merged.sessionId;
        usage.sessionFile = merged.sessionFile;
        mergeSessionUsageInto(usage, summary);
        usageByEntryIndex[session.entryIndex] = usage;
      }
    }

    // Track session-level aggregates across every matched session, so profile
    // stats stay correct when the row list is truncated by `limit`.
    let longestSessionDurationMs = 0;
    let activeSessionCount = 0;

    for (const [entryIndex, merged] of mergedEntries.entries()) {
      const agentId = merged.agentId;
      // A cold or stale cache intentionally yields null until its background refresh completes.
      const usage = usageByEntryIndex[entryIndex] ?? null;

      if (usage) {
        addCostUsageTotals(aggregateTotals, usage);
        longestSessionDurationMs = Math.max(longestSessionDurationMs, usage.durationMs ?? 0);
        // Discovery admits transcripts modified after endMs (they can still hold
        // in-range activity), so count only sessions whose filtered usage does.
        if (usage.firstActivity !== undefined || (usage.messageCounts?.total ?? 0) > 0) {
          activeSessionCount += 1;
        }
      }

      const channel = sessionDeliveryChannel(merged.storeEntry);
      const chatType =
        merged.storeEntry?.chatType ?? sessionDeliveryOrigin(merged.storeEntry)?.chatType;

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
                totals: createEmptyCostUsageTotals(),
              } as SessionModelUsage);
            modelExisting.count += entry.count;
            addCostUsageTotals(modelExisting.totals, entry.totals);
            byModelMap.set(modelKey, modelExisting);

            const providerKey = entry.provider ?? "unknown";
            const providerExisting =
              byProviderMap.get(providerKey) ??
              ({
                provider: entry.provider,
                model: undefined,
                count: 0,
                totals: createEmptyCostUsageTotals(),
              } as SessionModelUsage);
            providerExisting.count += entry.count;
            addCostUsageTotals(providerExisting.totals, entry.totals);
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
          const agentTotals = byAgentMap.get(agentId) ?? createEmptyCostUsageTotals();
          addCostUsageTotals(agentTotals, usage);
          byAgentMap.set(agentId, agentTotals);
        }

        if (channel) {
          const channelTotals = byChannelMap.get(channel) ?? createEmptyCostUsageTotals();
          addCostUsageTotals(channelTotals, usage);
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

      if (entryIndex < limit) {
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
          origin: sessionDeliveryOrigin(merged.storeEntry),
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
    }

    const tail = buildUsageAggregateTail({
      byChannelMap,
      latencyTotals,
      dailyLatencyMap,
      modelDailyMap,
      dailyMap: dailyAggregateMap,
    });

    const aggregates: SessionsUsageAggregates = {
      sessionCount: activeSessionCount,
      ...(longestSessionDurationMs > 0 ? { longestSessionDurationMs } : {}),
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
      startDate: formatDateLabel(startMs, dateInterpretation),
      endDate: formatDateLabel(endMs, dateInterpretation),
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
