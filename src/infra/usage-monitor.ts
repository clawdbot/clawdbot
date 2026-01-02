import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import { readAnthropicRateLimitSnapshot } from "./anthropic-rate-limits.js";
import { resolveUserPath } from "../utils.js";

export const CLAUDE_OPUS_MODEL = "claude-opus-4-5";
export const CLAUDE_OPUS_LIMITS = {
  inputTokensPerMinute: 40_000,
  outputTokensPerMinute: 8_000,
};

const DAILY_TIER_MULTIPLIERS: Record<string, number> = {
  "tier-1": 0.1,
  "tier-2": 0.25,
  "tier-3": 0.5,
  "tier-4": 1,
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  events: number;
};

export type UsageRateWindow = {
  usedTokens: number;
  limitTokens: number | null;
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: string | null;
  resetDescription?: string | null;
  estimated?: boolean;
};

export type UsageUnifiedWindow = {
  utilization: number;
  usedPercent: number;
  resetAt: string | null;
  status: string | null;
};

export type UsageUnifiedLimits = {
  fiveHour: UsageUnifiedWindow | null;
  sevenDay: UsageUnifiedWindow | null;
  fallback: string | null;
  fallbackPercentage: number | null;
};

export type UsageWarning = {
  level: "info" | "warn" | "error";
  message: string;
};

export type UsageSummary = {
  asOf: string;
  sessionsDir: string;
  sessionCount: number;
  currentSession?: {
    path: string;
    sessionId?: string;
    lastEventAt: string | null;
    totals: UsageTotals;
  };
  totals: {
    lastMinute: UsageTotals;
    thisHour: UsageTotals;
    today: UsageTotals;
  };
  rateLimits: {
    model: string;
    mode: "standard" | "unified";
    perMinute: {
      source?: "estimate" | "headers";
      input: UsageRateWindow;
      output: UsageRateWindow;
    } | null;
    daily: {
      tier: string | null;
      input: UsageRateWindow | null;
      output: UsageRateWindow | null;
      estimated: boolean;
    } | null;
    unified: UsageUnifiedLimits | null;
  };
  warnings: UsageWarning[];
};

export type UsageMonitorOptions = {
  sessionsDir?: string;
  now?: Date;
  tier?: string;
  dailyInputLimit?: number;
  dailyOutputLimit?: number;
};

type UsageEvent = {
  usage: ReturnType<typeof normalizeUsage>;
  costUsd?: number;
  timestampMs?: number | null;
};

type UsageFileSummary = {
  totals: UsageTotals;
  sessionId?: string;
  lastEventAtMs: number | null;
  missingTimestampEvents: number;
};

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  events: 0,
});

const addUsageTotals = (
  totals: UsageTotals,
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
  costUsd?: number,
) => {
  const input = Math.max(0, usage.input ?? 0);
  const output = Math.max(0, usage.output ?? 0);
  const cacheRead = Math.max(0, usage.cacheRead ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWrite ?? 0);
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.cacheReadTokens += cacheRead;
  totals.cacheWriteTokens += cacheWrite;
  totals.cacheTokens += cacheRead + cacheWrite;
  totals.totalTokens += input + output + cacheRead + cacheWrite;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
    totals.costUsd += costUsd;
  }
  totals.events += 1;
};

const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const extractCostUsd = (raw: unknown): number | undefined => {
  const direct = asFiniteNumber(raw);
  if (direct !== undefined) return direct;
  if (!raw || typeof raw !== "object") return undefined;
  const cost = raw as Record<string, unknown>;
  const total =
    asFiniteNumber(cost.total) ??
    asFiniteNumber(cost.totalUsd) ??
    asFiniteNumber(cost.usd) ??
    asFiniteNumber(cost.value);
  if (total !== undefined) return total;
  const input = asFiniteNumber(cost.input) ?? 0;
  const output = asFiniteNumber(cost.output) ?? 0;
  const cacheRead =
    asFiniteNumber(cost.cacheRead) ?? asFiniteNumber(cost.cache_read) ?? 0;
  const cacheWrite =
    asFiniteNumber(cost.cacheWrite) ?? asFiniteNumber(cost.cache_write) ?? 0;
  const sum = input + output + cacheRead + cacheWrite;
  return sum > 0 ? sum : undefined;
};

const extractTimestampMs = (entry: Record<string, unknown>): number | null => {
  const message =
    entry.message && typeof entry.message === "object"
      ? (entry.message as Record<string, unknown>)
      : undefined;
  const candidates: Array<unknown> = [
    message?.timestamp,
    entry.timestamp,
    entry.ts,
    entry.time,
    message?.created_at,
    entry.created_at,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate < 1_000_000_000_000 ? candidate * 1000 : candidate;
    }
    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && candidate.trim() !== "") {
        return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
      }
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
};

const extractUsageEvent = (entry: Record<string, unknown>): UsageEvent | null => {
  const directUsage = entry.usage as UsageLike | undefined;
  const message =
    entry.message && typeof entry.message === "object"
      ? (entry.message as Record<string, unknown>)
      : undefined;
  const messageUsage = message?.usage as UsageLike | undefined;
  const usageRaw = directUsage ?? messageUsage;
  const usage = normalizeUsage(usageRaw);
  if (!usage) return null;
  const costUsd = extractCostUsd(
    (usageRaw as Record<string, unknown> | undefined)?.cost,
  );
  const timestampMs = extractTimestampMs(entry);
  return { usage, costUsd, timestampMs };
};

const normalizeTier = (raw?: string): string | null => {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === "1" || trimmed === "tier1" || trimmed === "tier-1")
    return "tier-1";
  if (trimmed === "2" || trimmed === "tier2" || trimmed === "tier-2")
    return "tier-2";
  if (trimmed === "3" || trimmed === "tier3" || trimmed === "tier-3")
    return "tier-3";
  if (trimmed === "4" || trimmed === "tier4" || trimmed === "tier-4")
    return "tier-4";
  return DAILY_TIER_MULTIPLIERS[trimmed] ? trimmed : null;
};

const percentOf = (used: number, limit: number | null): number | null => {
  if (!limit || limit <= 0) return null;
  return Math.round((used / limit) * 1000) / 10;
};

const percentFromUtilization = (utilization: number): number =>
  Math.round(utilization * 1000) / 10;

const nextMinuteReset = (now: Date) => {
  const reset = new Date(now);
  reset.setSeconds(0, 0);
  reset.setMinutes(reset.getMinutes() + 1);
  return reset.toISOString();
};

const nextDayReset = (now: Date) => {
  const reset = new Date(now);
  reset.setHours(24, 0, 0, 0);
  return reset.toISOString();
};

const parseSnapshotMs = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
};

const buildHeaderWindow = (params: {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  fallbackUsed: number;
  now: Date;
}): UsageRateWindow => {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? params.limit
      : null;
  const remaining =
    typeof params.remaining === "number" && Number.isFinite(params.remaining)
      ? params.remaining
      : null;
  const resetAtMs = parseSnapshotMs(params.resetAt);
  const nowMs = params.now.getTime();
  const resetAt =
    resetAtMs && resetAtMs > nowMs
      ? new Date(resetAtMs).toISOString()
      : nextMinuteReset(params.now);
  const canUseRemaining =
    limit !== null &&
    remaining !== null &&
    (resetAtMs === null || resetAtMs > nowMs);
  const usedTokens = canUseRemaining
    ? Math.max(0, limit - remaining)
    : Math.max(0, params.fallbackUsed);
  const usedPercent = limit !== null ? percentOf(usedTokens, limit) : null;

  return {
    usedTokens,
    limitTokens: limit,
    usedPercent,
    windowMinutes: 1,
    resetsAt: resetAt,
    resetDescription:
      resetAtMs && resetAtMs > nowMs ? "rate limit reset" : "next minute",
    estimated: limit === null,
  };
};

const buildUnifiedWindow = (window?: {
  utilization?: number;
  resetAt?: string;
  status?: string;
}): UsageUnifiedWindow | null => {
  const utilization = window?.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null;
  }
  const resetAt =
    typeof window?.resetAt === "string" && window.resetAt.trim()
      ? window.resetAt
      : null;
  const status =
    typeof window?.status === "string" && window.status.trim()
      ? window.status
      : null;
  return {
    utilization,
    usedPercent: percentFromUtilization(utilization),
    resetAt,
    status,
  };
};

const scanUsageFile = async (
  filePath: string,
  onUsage: (event: UsageEvent) => void,
): Promise<UsageFileSummary> => {
  const totals = emptyTotals();
  let sessionId: string | undefined;
  let lastEventAtMs: number | null = null;
  let missingTimestampEvents = 0;
  const stream = await fs.open(filePath, "r");
  const input = stream.createReadStream({ encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!sessionId && entry.type === "session") {
        const rawId = entry.id;
        if (typeof rawId === "string" && rawId.trim()) {
          sessionId = rawId.trim();
        }
      }
      const event = extractUsageEvent(entry);
      if (!event || !event.usage) continue;
      addUsageTotals(totals, event.usage, event.costUsd);
      if (event.timestampMs != null) {
        lastEventAtMs =
          lastEventAtMs === null
            ? event.timestampMs
            : Math.max(lastEventAtMs, event.timestampMs);
      } else {
        missingTimestampEvents += 1;
      }
      onUsage(event);
    }
  } finally {
    await reader.close();
    await stream.close();
  }
  return { totals, sessionId, lastEventAtMs, missingTimestampEvents };
};

export async function collectUsageSummary(
  options: UsageMonitorOptions = {},
): Promise<UsageSummary> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const sessionDir = options.sessionsDir
    ? resolveUserPath(options.sessionsDir)
    : resolveSessionTranscriptsDir();

  const lastMinuteTotals = emptyTotals();
  const thisHourTotals = emptyTotals();
  const todayTotals = emptyTotals();
  const warnings: UsageWarning[] = [];

  const minuteStartMs = nowMs - 60_000;
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  const hourStartMs = hourStart.getTime();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  let sessionFiles: Array<{ path: string; mtimeMs: number }> = [];
  try {
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    sessionFiles = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const fullPath = path.join(sessionDir, entry.name);
          const stat = await fs.stat(fullPath);
          return { path: fullPath, mtimeMs: stat.mtimeMs };
        }),
    );
  } catch (err) {
    warnings.push({
      level: "warn",
      message: `Sessions dir not readable: ${sessionDir} (${String(err)})`,
    });
  }

  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const currentFile = sessionFiles[0]?.path;
  let currentSession:
    | UsageSummary["currentSession"]
    | undefined = undefined;
  let missingTimestampEvents = 0;

  const onUsage = (event: UsageEvent) => {
    if (!event.usage) return;
    const timestampMs = event.timestampMs;
    if (timestampMs == null) return;
    if (timestampMs >= minuteStartMs) {
      addUsageTotals(lastMinuteTotals, event.usage, event.costUsd);
    }
    if (timestampMs >= hourStartMs) {
      addUsageTotals(thisHourTotals, event.usage, event.costUsd);
    }
    if (timestampMs >= dayStartMs) {
      addUsageTotals(todayTotals, event.usage, event.costUsd);
    }
  };

  for (const file of sessionFiles) {
    try {
      const summary = await scanUsageFile(file.path, onUsage);
      missingTimestampEvents += summary.missingTimestampEvents;
      if (file.path === currentFile) {
        currentSession = {
          path: file.path,
          sessionId: summary.sessionId,
          lastEventAt: summary.lastEventAtMs
            ? new Date(summary.lastEventAtMs).toISOString()
            : null,
          totals: summary.totals,
        };
      }
    } catch (err) {
      warnings.push({
        level: "warn",
        message: `Failed to parse ${file.path}: ${String(err)}`,
      });
    }
  }

  if (sessionFiles.length === 0) {
    warnings.push({
      level: "warn",
      message: `No session logs found in ${sessionDir}`,
    });
  }

  if (missingTimestampEvents > 0) {
    warnings.push({
      level: "info",
      message: `Skipped ${missingTimestampEvents} usage events without timestamps.`,
    });
  }

  const rateSnapshot = await readAnthropicRateLimitSnapshot();
  const isUnified = rateSnapshot?.type === "unified";
  let rateLimitMode: UsageSummary["rateLimits"]["mode"] = "standard";
  let perMinute: UsageSummary["rateLimits"]["perMinute"] = null;
  let daily: UsageSummary["rateLimits"]["daily"] = null;
  let unified: UsageSummary["rateLimits"]["unified"] = null;

  if (isUnified) {
    rateLimitMode = "unified";
    const fallbackValue =
      typeof rateSnapshot?.unified?.fallback === "string"
        ? rateSnapshot.unified?.fallback ?? null
        : null;
    const fallbackPercentage = asFiniteNumber(
      rateSnapshot?.unified?.fallbackPercentage,
    );
    unified = {
      fiveHour: buildUnifiedWindow(rateSnapshot?.unified?.fiveHour),
      sevenDay: buildUnifiedWindow(rateSnapshot?.unified?.sevenDay),
      fallback: fallbackValue,
      fallbackPercentage: fallbackPercentage ?? null,
    };

    const warnIfUnifiedHigh = (
      label: string,
      window: UsageUnifiedWindow | null,
    ) => {
      if (!window) return;
      const utilization = window.utilization;
      if (!Number.isFinite(utilization)) return;
      const remaining = Math.max(
        0,
        Math.round((1 - utilization) * 1000) / 10,
      );
      const thresholds: Array<{ cutoff: number; level: "error" | "warn"; label: string }> = [
        { cutoff: 0.99, level: "error", label: "critical" },
        { cutoff: 0.95, level: "error", label: "red" },
        { cutoff: 0.9, level: "warn", label: "orange" },
        { cutoff: 0.75, level: "warn", label: "yellow" },
      ];
      for (const threshold of thresholds) {
        if (utilization >= threshold.cutoff) {
          warnings.push({
            level: threshold.level,
            message: `${label} utilization at ${window.usedPercent}% (${threshold.label} warning, ${remaining}% remaining).`,
          });
          break;
        }
      }
    };

    warnIfUnifiedHigh("5h window", unified.fiveHour);
    warnIfUnifiedHigh("7d window", unified.sevenDay);
  } else {
    const tokensLimit = asFiniteNumber(rateSnapshot?.tokens?.limit);
    const tokensRemaining = asFiniteNumber(rateSnapshot?.tokens?.remaining);
    const tokensResetAt =
      typeof rateSnapshot?.tokens?.resetAt === "string"
        ? rateSnapshot.tokens.resetAt
        : undefined;
    const requestsLimit = asFiniteNumber(rateSnapshot?.requests?.limit);
    const requestsRemaining = asFiniteNumber(rateSnapshot?.requests?.remaining);
    const requestsResetAt =
      typeof rateSnapshot?.requests?.resetAt === "string"
        ? rateSnapshot.requests.resetAt
        : undefined;
    const perMinuteSource = tokensLimit !== undefined ? "headers" : "estimate";

    const tierFromEnv =
      process.env.CLAWDIS_ANTHROPIC_TIER ??
      process.env.ANTHROPIC_TIER ??
      "tier-4";
    const tier = normalizeTier(options.tier ?? tierFromEnv);
    const maxDailyInput =
      CLAUDE_OPUS_LIMITS.inputTokensPerMinute * 60 * 24;
    const maxDailyOutput =
      CLAUDE_OPUS_LIMITS.outputTokensPerMinute * 60 * 24;
    const multiplier = tier ? DAILY_TIER_MULTIPLIERS[tier] ?? null : null;
    const dailyInputLimit =
      options.dailyInputLimit ??
      (multiplier ? Math.round(maxDailyInput * multiplier) : null);
    const dailyOutputLimit =
      options.dailyOutputLimit ??
      (multiplier ? Math.round(maxDailyOutput * multiplier) : null);
    const dailyInputEstimated = options.dailyInputLimit == null;
    const dailyOutputEstimated = options.dailyOutputLimit == null;
    const dailyEstimated = dailyInputEstimated || dailyOutputEstimated;

    if (!tier) {
      warnings.push({
        level: "info",
        message:
          "Daily limits are estimated; set --tier or CLAWDIS_ANTHROPIC_TIER to improve accuracy.",
      });
    }

    const inputMinuteWindow: UsageRateWindow =
      perMinuteSource === "headers"
        ? buildHeaderWindow({
            limit: tokensLimit,
            remaining: tokensRemaining,
            resetAt: tokensResetAt,
            fallbackUsed: lastMinuteTotals.totalTokens,
            now,
          })
        : {
            usedTokens: lastMinuteTotals.inputTokens,
            limitTokens: CLAUDE_OPUS_LIMITS.inputTokensPerMinute,
            usedPercent: percentOf(
              lastMinuteTotals.inputTokens,
              CLAUDE_OPUS_LIMITS.inputTokensPerMinute,
            ),
            windowMinutes: 1,
            resetsAt: nextMinuteReset(now),
            resetDescription: "next minute",
            estimated: true,
          };

    const outputMinuteWindow: UsageRateWindow =
      perMinuteSource === "headers"
        ? buildHeaderWindow({
            limit: requestsLimit,
            remaining: requestsRemaining,
            resetAt: requestsResetAt,
            fallbackUsed: lastMinuteTotals.events,
            now,
          })
        : {
            usedTokens: lastMinuteTotals.outputTokens,
            limitTokens: CLAUDE_OPUS_LIMITS.outputTokensPerMinute,
            usedPercent: percentOf(
              lastMinuteTotals.outputTokens,
              CLAUDE_OPUS_LIMITS.outputTokensPerMinute,
            ),
            windowMinutes: 1,
            resetsAt: nextMinuteReset(now),
            resetDescription: "next minute",
            estimated: true,
          };

    const dailyInputWindow: UsageRateWindow | null = dailyInputLimit
      ? {
          usedTokens: todayTotals.inputTokens,
          limitTokens: dailyInputLimit,
          usedPercent: percentOf(todayTotals.inputTokens, dailyInputLimit),
          windowMinutes: 1440,
          resetsAt: nextDayReset(now),
          resetDescription: "midnight local time",
          estimated: dailyInputEstimated,
        }
      : null;

    const dailyOutputWindow: UsageRateWindow | null = dailyOutputLimit
      ? {
          usedTokens: todayTotals.outputTokens,
          limitTokens: dailyOutputLimit,
          usedPercent: percentOf(todayTotals.outputTokens, dailyOutputLimit),
          windowMinutes: 1440,
          resetsAt: nextDayReset(now),
          resetDescription: "midnight local time",
          estimated: dailyOutputEstimated,
        }
      : null;

    const warnIfHigh = (
      label: string,
      window: UsageRateWindow | null,
    ) => {
      if (window?.usedPercent == null) return;
      if (window.usedPercent >= 100) {
        warnings.push({
          level: "error",
          message: `${label} exceeded (${window.usedPercent}%).`,
        });
      } else if (window.usedPercent >= 80) {
        warnings.push({
          level: "warn",
          message: `${label} at ${window.usedPercent}%.`,
        });
      }
    };

    const perMinuteInputLabel =
      perMinuteSource === "headers"
        ? "Tokens per minute"
        : "Input tokens per minute";
    const perMinuteOutputLabel =
      perMinuteSource === "headers"
        ? "Requests per minute"
        : "Output tokens per minute";
    warnIfHigh(perMinuteInputLabel, inputMinuteWindow);
    warnIfHigh(perMinuteOutputLabel, outputMinuteWindow);
    warnIfHigh("Daily input tokens", dailyInputWindow);
    warnIfHigh("Daily output tokens", dailyOutputWindow);

    perMinute = {
      source: perMinuteSource,
      input: inputMinuteWindow,
      output: outputMinuteWindow,
    };
    daily = {
      tier,
      input: dailyInputWindow,
      output: dailyOutputWindow,
      estimated: dailyEstimated,
    };
  }

  return {
    asOf: now.toISOString(),
    sessionsDir: sessionDir,
    sessionCount: sessionFiles.length,
    currentSession,
    totals: {
      lastMinute: lastMinuteTotals,
      thisHour: thisHourTotals,
      today: todayTotals,
    },
    rateLimits: {
      model: CLAUDE_OPUS_MODEL,
      mode: rateLimitMode,
      perMinute,
      daily,
      unified,
    },
    warnings,
  };
}
