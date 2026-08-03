// Fetches and normalizes MiniMax provider usage records.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { isRecord } from "../utils.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";
import {
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  parseFiniteNumber,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type MinimaxBaseResp = {
  status_code?: number;
  status_msg?: string;
};

type MinimaxUsageResponse = {
  base_resp?: MinimaxBaseResp;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

type FetchMinimaxUsageOptions = {
  baseUrl?: string;
};

const DEFAULT_MINIMAX_USAGE_ORIGIN = "https://api.minimaxi.com";
const MINIMAX_USAGE_PATH = "/v1/token_plan/remains";

const RESET_KEYS = [
  "reset_at",
  "resetAt",
  "reset_time",
  "resetTime",
  "next_reset_at",
  "nextResetAt",
  "next_reset_time",
  "nextResetTime",
  "expires_at",
  "expiresAt",
  "expire_at",
  "expireAt",
  "end_time",
  "endTime",
  "window_end",
  "windowEnd",
] as const;

const PERCENT_KEYS = [
  "used_percent",
  "usedPercent",
  "used_rate",
  "usage_rate",
  "used_ratio",
  "usage_ratio",
  "usedRatio",
  "usageRatio",
] as const;

// Legacy usage_percent / usagePercent fields report remaining quota, not consumption.
// Generic payloads keep count priority; canonical model rows opt into the provider's
// dedicated remaining-percent fields as their authoritative values.
const REMAINING_PERCENT_KEYS = ["usage_percent", "usagePercent"] as const;

const CURRENT_INTERVAL_TOTAL_KEYS = [
  "current_interval_total_count",
  "currentIntervalTotalCount",
] as const;
const CURRENT_INTERVAL_REMAINING_KEYS = [
  "current_interval_usage_count",
  "currentIntervalUsageCount",
] as const;
const CURRENT_INTERVAL_REMAINING_PERCENT_KEYS = [
  "current_interval_remaining_percent",
  "currentIntervalRemainingPercent",
] as const;
const CURRENT_INTERVAL_STATUS_KEYS = ["current_interval_status", "currentIntervalStatus"] as const;
const CURRENT_WEEKLY_TOTAL_KEYS = [
  "current_weekly_total_count",
  "currentWeeklyTotalCount",
] as const;
const CURRENT_WEEKLY_REMAINING_KEYS = [
  "current_weekly_usage_count",
  "currentWeeklyUsageCount",
] as const;
const CURRENT_WEEKLY_REMAINING_PERCENT_KEYS = [
  "current_weekly_remaining_percent",
  "currentWeeklyRemainingPercent",
] as const;
const CURRENT_WEEKLY_STATUS_KEYS = ["current_weekly_status", "currentWeeklyStatus"] as const;
const MODEL_REMAINING_PERCENT_KEYS = [
  ...CURRENT_INTERVAL_REMAINING_PERCENT_KEYS,
  ...CURRENT_WEEKLY_REMAINING_PERCENT_KEYS,
] as const;
const NO_USAGE_KEYS = [] as const;

const USED_KEYS = [
  "used",
  "usage",
  "used_amount",
  "usedAmount",
  "used_tokens",
  "usedTokens",
  "used_quota",
  "usedQuota",
  "used_times",
  "usedTimes",
  "prompt_used",
  "promptUsed",
  "used_prompt",
  "usedPrompt",
  "prompts_used",
  "promptsUsed",
  "consumed",
] as const;

const TOTAL_KEYS = [
  "total",
  "total_amount",
  "totalAmount",
  "total_tokens",
  "totalTokens",
  "total_quota",
  "totalQuota",
  "total_times",
  "totalTimes",
  "prompt_total",
  "promptTotal",
  "total_prompt",
  "totalPrompt",
  "prompt_limit",
  "promptLimit",
  "limit_prompt",
  "limitPrompt",
  "prompts_total",
  "promptsTotal",
  "total_prompts",
  "totalPrompts",
  "current_interval_total_count",
  "currentIntervalTotalCount",
  "current_weekly_total_count",
  "currentWeeklyTotalCount",
  "limit",
  "quota",
  "quota_limit",
  "quotaLimit",
  "max",
] as const;

const REMAINING_KEYS = [
  "remain",
  "remaining",
  "remain_amount",
  "remainingAmount",
  "remaining_amount",
  "remain_tokens",
  "remainingTokens",
  "remaining_tokens",
  "remain_quota",
  "remainingQuota",
  "remaining_quota",
  "remain_times",
  "remainingTimes",
  "remaining_times",
  "prompt_remain",
  "promptRemain",
  "remain_prompt",
  "remainPrompt",
  "prompt_remaining",
  "promptRemaining",
  "remaining_prompt",
  "remainingPrompt",
  "prompts_remaining",
  "promptsRemaining",
  "prompt_left",
  "promptLeft",
  "prompts_left",
  "promptsLeft",
  "left",
  // MiniMax usage endpoints misname these: values are remaining quota, not consumed.
  // See https://github.com/MiniMax-AI/MiniMax-M2/issues/99
  "current_interval_usage_count",
  "currentIntervalUsageCount",
  "current_weekly_usage_count",
  "currentWeeklyUsageCount",
] as const;

const PLAN_KEYS = ["plan", "plan_name", "planName", "product", "tier"] as const;

const WINDOW_HOUR_KEYS = [
  "window_hours",
  "windowHours",
  "duration_hours",
  "durationHours",
  "hours",
] as const;

const WINDOW_MINUTE_KEYS = [
  "window_minutes",
  "windowMinutes",
  "duration_minutes",
  "durationMinutes",
  "minutes",
] as const;

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = parseFiniteNumber(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return readTrimmedStringAlias(record, keys);
}

function parseEpoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestampMs = value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
    return asDateTimestampMs(timestampMs);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = parseFiniteNumber(value);
    if (numeric !== undefined) {
      return parseEpoch(numeric);
    }
    const parsed = Date.parse(value);
    return asDateTimestampMs(parsed);
  }
  return undefined;
}

function hasAny(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => key in record);
}

function scoreUsageRecord(record: Record<string, unknown>): number {
  let score = 0;
  if (hasAny(record, PERCENT_KEYS) || hasAny(record, MODEL_REMAINING_PERCENT_KEYS)) {
    score += 4;
  }
  if (hasAny(record, TOTAL_KEYS)) {
    score += 3;
  }
  if (hasAny(record, USED_KEYS) || hasAny(record, REMAINING_KEYS)) {
    score += 2;
  }
  if (hasAny(record, RESET_KEYS)) {
    score += 1;
  }
  if (hasAny(record, PLAN_KEYS)) {
    score += 1;
  }
  return score;
}

function collectUsageCandidates(root: Record<string, unknown>): Record<string, unknown>[] {
  const MAX_SCAN_DEPTH = 4;
  const MAX_SCAN_NODES = 60;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  const candidates: Array<{ record: Record<string, unknown>; score: number; depth: number }> = [];
  let scanned = 0;

  while (queue.length && scanned < MAX_SCAN_NODES) {
    const next = queue.shift() as { value: unknown; depth: number };
    scanned += 1;
    const { value, depth } = next;

    if (isRecord(value)) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      const score = scoreUsageRecord(value);
      if (score > 0) {
        candidates.push({ record: value, score, depth });
      }
      if (depth < MAX_SCAN_DEPTH) {
        for (const nested of Object.values(value)) {
          if (isRecord(nested) || Array.isArray(nested)) {
            queue.push({ value: nested, depth: depth + 1 });
          }
        }
      }
      continue;
    }

    if (Array.isArray(value) && depth < MAX_SCAN_DEPTH) {
      for (const nested of value) {
        if (isRecord(nested) || Array.isArray(nested)) {
          queue.push({ value: nested, depth: depth + 1 });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.depth - b.depth);
  return candidates.map((candidate) => candidate.record);
}

function deriveWindowLabelFromTimestamps(record: Record<string, unknown>): string | undefined {
  const startTime = parseEpoch(record.start_time ?? record.startTime);
  const endTime = parseEpoch(record.end_time ?? record.endTime);
  if (startTime !== undefined && endTime !== undefined && endTime > startTime) {
    const durationHours = (endTime - startTime) / 3_600_000;
    if (durationHours >= 1 && Number.isFinite(durationHours)) {
      const rounded = Math.round(durationHours);
      return `${rounded}h`;
    }
    const durationMinutes = Math.round((endTime - startTime) / 60_000);
    if (durationMinutes > 0) {
      return `${durationMinutes}m`;
    }
  }
  return undefined;
}

function deriveWindowLabel(payload: Record<string, unknown>): string {
  const hours = pickNumber(payload, WINDOW_HOUR_KEYS);
  if (hours && Number.isFinite(hours)) {
    return `${hours}h`;
  }
  const minutes = pickNumber(payload, WINDOW_MINUTE_KEYS);
  if (minutes && Number.isFinite(minutes)) {
    return `${minutes}m`;
  }
  const fromTimestamps = deriveWindowLabelFromTimestamps(payload);
  if (fromTimestamps) {
    return fromTimestamps;
  }
  return "5h";
}

function deriveUsedPercent(
  payload: Record<string, unknown>,
  keys: {
    total?: readonly string[];
    used?: readonly string[];
    remaining?: readonly string[];
    percent?: readonly string[];
    remainingPercent?: readonly string[];
    remainingPercentUnit?: "percent" | "ratio-or-percent";
    preferRemainingPercent?: boolean;
  } = {},
): number | null {
  const remainingPercentRaw = pickNumber(payload, keys.remainingPercent ?? REMAINING_PERCENT_KEYS);
  const remainingPercentUnit = keys.remainingPercentUnit ?? "ratio-or-percent";
  const fromRemainingPercent =
    remainingPercentRaw === undefined
      ? null
      : clampPercent(
          100 -
            clampPercent(
              remainingPercentUnit === "ratio-or-percent" && remainingPercentRaw <= 1
                ? remainingPercentRaw * 100
                : remainingPercentRaw,
            ),
        );
  if (keys.preferRemainingPercent === true && fromRemainingPercent !== null) {
    return fromRemainingPercent;
  }

  const total = pickNumber(payload, keys.total ?? TOTAL_KEYS);
  let used = pickNumber(payload, keys.used ?? USED_KEYS);
  const remaining = pickNumber(payload, keys.remaining ?? REMAINING_KEYS);
  if (used === undefined && remaining !== undefined && total !== undefined) {
    used = total - remaining;
  }

  const fromCounts =
    total && total > 0 && used !== undefined && Number.isFinite(used)
      ? clampPercent((used / total) * 100)
      : null;

  // Count-derived usage is more stable across provider percent field variations.
  if (fromCounts !== null) {
    return fromCounts;
  }

  const percentRaw = pickNumber(payload, keys.percent ?? PERCENT_KEYS);
  if (percentRaw !== undefined) {
    return clampPercent(percentRaw <= 1 ? percentRaw * 100 : percentRaw);
  }

  // usage_percent / usagePercent in MiniMax's API represents remaining quota,
  // not consumed quota. Invert to get usedPercent.
  if (fromRemainingPercent !== null) {
    return fromRemainingPercent;
  }

  return null;
}

function hasModelUsageEvidence(record: Record<string, unknown>): boolean {
  return (
    hasAny(record, MODEL_REMAINING_PERCENT_KEYS) ||
    (pickNumber(record, CURRENT_INTERVAL_TOTAL_KEYS) ?? 0) > 0 ||
    (pickNumber(record, CURRENT_WEEKLY_TOTAL_KEYS) ?? 0) > 0
  );
}

function isChatModelUsageRecord(record: Record<string, unknown>): boolean {
  const name = normalizeLowercaseStringOrEmpty(
    typeof record.model_name === "string" ? record.model_name : "",
  );
  return name === "general" || name.startsWith("minimax-m");
}

function isBoundedMinimaxStatus(status: number | undefined): boolean {
  return status === 1 || status === 2;
}

function isBoundedModelUsageRecord(record: Record<string, unknown>): boolean {
  return (
    isBoundedMinimaxStatus(pickNumber(record, CURRENT_INTERVAL_STATUS_KEYS)) ||
    isBoundedMinimaxStatus(pickNumber(record, CURRENT_WEEKLY_STATUS_KEYS))
  );
}

// MiniMax's current API uses `general` for the chat quota and can report zero counts
// with authoritative percentage fields. Prefer that owner before status-based fallbacks.
function pickChatModelRemains(modelRemains: unknown[]): Record<string, unknown> | undefined {
  const records = modelRemains.filter(isRecord).filter(hasModelUsageEvidence);
  if (records.length === 0) {
    return undefined;
  }

  return (
    records.find(isChatModelUsageRecord) ?? records.find(isBoundedModelUsageRecord) ?? records[0]
  );
}

function pickEpoch(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = parseEpoch(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function shouldExposeMinimaxWindow(
  record: Record<string, unknown>,
  statusKeys: readonly string[],
): boolean {
  // MiniMax status 3 is unlimited. UsageWindow cannot represent infinity, so a 0%-used
  // bounded bar would be misleading; legacy rows without status remain visible.
  return pickNumber(record, statusKeys) !== 3;
}

function deriveMinimaxModelWindows(record: Record<string, unknown>): {
  recognized: boolean;
  windows: UsageWindow[];
} {
  const windows: UsageWindow[] = [];
  const currentUsedPercent = deriveUsedPercent(record, {
    total: CURRENT_INTERVAL_TOTAL_KEYS,
    used: NO_USAGE_KEYS,
    remaining: CURRENT_INTERVAL_REMAINING_KEYS,
    percent: NO_USAGE_KEYS,
    remainingPercent: CURRENT_INTERVAL_REMAINING_PERCENT_KEYS,
    remainingPercentUnit: "percent",
    preferRemainingPercent: true,
  });
  if (
    currentUsedPercent !== null &&
    shouldExposeMinimaxWindow(record, CURRENT_INTERVAL_STATUS_KEYS)
  ) {
    windows.push({
      label: deriveWindowLabel(record),
      usedPercent: currentUsedPercent,
      resetAt: pickEpoch(record, ["end_time", "endTime"]),
    });
  }

  const weeklyUsedPercent = deriveUsedPercent(record, {
    total: CURRENT_WEEKLY_TOTAL_KEYS,
    used: NO_USAGE_KEYS,
    remaining: CURRENT_WEEKLY_REMAINING_KEYS,
    percent: NO_USAGE_KEYS,
    remainingPercent: CURRENT_WEEKLY_REMAINING_PERCENT_KEYS,
    remainingPercentUnit: "percent",
    preferRemainingPercent: true,
  });
  if (weeklyUsedPercent !== null && shouldExposeMinimaxWindow(record, CURRENT_WEEKLY_STATUS_KEYS)) {
    windows.push({
      label: "Week",
      usedPercent: weeklyUsedPercent,
      resetAt: pickEpoch(record, ["weekly_end_time", "weeklyEndTime"]),
    });
  }

  return {
    recognized: currentUsedPercent !== null || weeklyUsedPercent !== null,
    windows,
  };
}

function resolveMinimaxUsageUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return `${DEFAULT_MINIMAX_USAGE_ORIGIN}${MINIMAX_USAGE_PATH}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.origin}${MINIMAX_USAGE_PATH}`;
    }
  } catch {
    // Fall through to the stable CN default for malformed config values.
  }

  return `${DEFAULT_MINIMAX_USAGE_ORIGIN}${MINIMAX_USAGE_PATH}`;
}

export async function fetchMinimaxUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  options?: FetchMinimaxUsageOptions,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    resolveMinimaxUsageUrl(options?.baseUrl),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    await discardUsageResponseBody(res);
    return buildUsageHttpErrorSnapshot({
      provider: "minimax",
      status: res.status,
    });
  }

  const data = await readProviderJsonResponse<MinimaxUsageResponse>(res, "minimax usage").catch(
    () => null,
  );
  if (!isRecord(data)) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: "Invalid JSON",
    };
  }

  const baseResp = isRecord(data.base_resp) ? data.base_resp : undefined;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    return {
      provider: "minimax",
      displayName: PROVIDER_LABELS.minimax,
      windows: [],
      error: baseResp.status_msg?.trim() || "API error",
    };
  }

  const payload = isRecord(data.data) ? data.data : data;

  // Handle the model_remains array structure returned by the coding-plan
  // endpoint.  Pick the chat-model entry so that speech/video/image quotas
  // (which often have total_count === 0) don't shadow the relevant budget.
  const modelRemains = Array.isArray(payload.model_remains) ? payload.model_remains : null;
  const chatRemains = modelRemains ? pickChatModelRemains(modelRemains) : undefined;

  const usageSource = chatRemains ?? payload;
  let usageRecord: Record<string, unknown> = usageSource;
  const modelUsage = chatRemains ? deriveMinimaxModelWindows(chatRemains) : undefined;
  let windows = modelUsage?.windows ?? [];
  if (modelUsage?.recognized !== true) {
    const candidates = collectUsageCandidates(usageSource);
    let usedPercent: number | null = null;
    for (const candidate of candidates) {
      const candidatePercent = deriveUsedPercent(candidate);
      if (candidatePercent !== null) {
        usageRecord = candidate;
        usedPercent = candidatePercent;
        break;
      }
    }
    if (usedPercent === null) {
      usedPercent = deriveUsedPercent(usageSource);
    }
    if (usedPercent === null) {
      return {
        provider: "minimax",
        displayName: PROVIDER_LABELS.minimax,
        windows: [],
        error: "Unsupported response shape",
      };
    }

    const resetAt =
      parseEpoch(pickString(usageRecord, RESET_KEYS)) ??
      parseEpoch(pickNumber(usageRecord, RESET_KEYS)) ??
      parseEpoch(pickString(payload, RESET_KEYS)) ??
      parseEpoch(pickNumber(payload, RESET_KEYS));
    windows = [
      {
        label: deriveWindowLabel(usageRecord),
        usedPercent,
        resetAt,
      },
    ];
  }

  const modelName =
    chatRemains && typeof chatRemains.model_name === "string" ? chatRemains.model_name : undefined;
  const plan =
    pickString(usageRecord, PLAN_KEYS) ??
    pickString(payload, PLAN_KEYS) ??
    (modelName ? `Coding Plan · ${modelName}` : undefined);

  return {
    provider: "minimax",
    displayName: PROVIDER_LABELS.minimax,
    windows,
    plan,
  };
}
