import fs from "node:fs";
import { loadConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import type {
  CostUsageSummary,
  SessionDailyModelUsage,
  SessionMessageCounts,
  SessionModelUsage,
} from "../../infra/session-cost-usage.js";
import {
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionUsageTimeSeries,
  discoverAllSessions,
  resolveExistingUsageSessionFile,
  type DiscoveredSession,
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

function resolveSessionUsageFileOrRespond(
  key: string,
  respond: RespondFn,
): {
  config: OpenClawConfig;
  entry: SessionEntry | undefined;
  agentId: string | undefined;
  sessionId: string;
  sessionFile: string;
} | null {
  const config = loadConfig();
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

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
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
      });
      return sessions.map((session) => ({ ...session, agentId: agent.id }));
    }),
  );
  return results.flat().toSorted((a, b) => b.mtime - a.mtime);
}

async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  const cacheKey = `${params.startMs}-${params.endMs}`;
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
  const inFlight = loadCostUsageSummary({
    startMs: params.startMs,
    endMs: params.endMs,
    config: params.config,
  })
    .then((summary) => {
      costUsageCache.set(cacheKey, { summary, updatedAt: Date.now() });
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
        costUsageCache.set(cacheKey, current);
      }
    });

  entry.inFlight = inFlight;
  costUsageCache.set(cacheKey, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
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
  "usage.cost": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
      mode: params?.mode,
      utcOffset: params?.utcOffset,
    });
    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params }) => {
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
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: p.startDate,
      endDate: p.endDate,
      mode: p.mode,
      utcOffset: p.utcOffset,
    });
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = normalizeOptionalString(p.key) ?? null;

    // Load session store for named sessions
    const { storePath, store } = loadCombinedSessionStoreForGateway(config);
    const now = Date.now();

    // Merge discovered sessions with store entries
    type MergedEntry = {
      key: string;
      sessionId: string;
      sessionFile: string;
      label?: string;
      updatedAt: number;
      storeEntry?: SessionEntry;
      firstUserMessage?: string;
    };

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
            mergedEntries.push({
              key: resolvedStoreKey,
              sessionId,
              sessionFile,
              label: storeEntry?.label,
              updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
              storeEntry,
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

      for (const discovered of discoveredSessions) {
        const storeMatch = storeBySessionId.get(discovered.sessionId);
        if (storeMatch) {
          // Named session from store
          mergedEntries.push({
            key: storeMatch.key,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: storeMatch.entry.label,
            updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
            storeEntry: storeMatch.entry,
          });
        } else {
          // Unnamed session - use session ID as key, no label
          mergedEntries.push({
            // Keep agentId in the key so the dashboard can attribute sessions and later fetch logs.
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: undefined, // No label for unnamed sessions
            updatedAt: discovered.mtime,
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
      const usage = await loadSessionCostSummary({
        sessionId: merged.sessionId,
        sessionEntry: merged.storeEntry,
        sessionFile: merged.sessionFile,
        config,
        agentId,
        startMs,
        endMs,
      });

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
    };

    respond(true, result, undefined);
  },
  "sessions.usage.timeseries": async ({ respond, params }) => {
    const key = normalizeOptionalString(params?.key) ?? null;
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"),
      );
      return;
    }

    const resolved = resolveSessionUsageFileOrRespond(key, respond);
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
  "sessions.usage.logs": async ({ respond, params }) => {
    const key = normalizeOptionalString(params?.key) ?? null;
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
      return;
    }

    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const resolved = resolveSessionUsageFileOrRespond(key, respond);
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const { loadSessionLogs } = await import("../../infra/session-cost-usage.js");
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
