import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// Fetches Codex provider usage windows.
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { fetchUsageJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;
const WEEK_MINUTES = 7 * 24 * 60;

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readProviderNumber(value: unknown): number | undefined {
  return typeof value === "string" ? parseStrictFiniteNumber(value) : readFiniteNumber(value);
}

function rateLimitReachedSummary(value: unknown): string | undefined {
  const reachedType = asOptionalRecord(value)?.type;
  switch (reachedType) {
    case "rate_limit_reached":
      return "Usage limit reached";
    case "workspace_owner_credits_depleted":
      return "Workspace credits depleted — add credits to continue";
    case "workspace_member_credits_depleted":
      return "Workspace credits depleted — ask an owner to refill";
    case "workspace_owner_usage_limit_reached":
      return "Workspace spend cap reached — increase it to continue";
    case "workspace_member_usage_limit_reached":
      return "Workspace spend cap reached — ask an owner to increase it";
    default:
      return undefined;
  }
}

function resolveSecondaryWindowLabel(params: {
  windowHours: number;
  secondaryResetAt?: number;
  primaryResetAt?: number;
}): string {
  if (params.windowHours >= 168) {
    return "Week";
  }
  if (params.windowHours < 24) {
    return `${params.windowHours}h`;
  }
  // Codex occasionally reports a 24h secondary window while exposing a
  // weekly reset cadence in reset timestamps. Prefer cadence in that case.
  if (
    typeof params.secondaryResetAt === "number" &&
    typeof params.primaryResetAt === "number" &&
    params.secondaryResetAt - params.primaryResetAt >= WEEKLY_RESET_GAP_SECONDS
  ) {
    return "Week";
  }
  return "Day";
}

function formatWindowDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes === WEEK_MINUTES) {
    return "Week";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function normalizeRateLimitLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function resolveAdditionalRateLimitLabel(
  limitName: string | undefined,
  meteredFeature: string | undefined,
): string | undefined {
  return normalizeRateLimitLabel(limitName ?? meteredFeature);
}

function appendRateLimitWindows(
  windows: UsageWindow[],
  rawRateLimit: unknown,
  limitLabel?: string,
): void {
  const rateLimit = asOptionalRecord(rawRateLimit);
  const windowFields = (windowLabel: string) => ({
    label: limitLabel ? `${limitLabel} · ${windowLabel}` : windowLabel,
    ...(limitLabel
      ? {
          groupLabel: limitLabel,
          windowLabel,
        }
      : {}),
  });
  const primary = asOptionalRecord(rateLimit?.primary_window);
  if (primary) {
    const limitSeconds = readFiniteNumber(primary.limit_window_seconds) ?? 10_800;
    const resetAt = readFiniteNumber(primary.reset_at);
    windows.push({
      ...windowFields(formatWindowDuration(limitSeconds)),
      usedPercent: clampPercent(readFiniteNumber(primary.used_percent) ?? 0),
      resetAt: resetAt ? resetAt * 1000 : undefined,
    });
  }

  const secondary = asOptionalRecord(rateLimit?.secondary_window);
  if (secondary) {
    const limitSeconds = readFiniteNumber(secondary.limit_window_seconds) ?? 86_400;
    const resetAt = readFiniteNumber(secondary.reset_at);
    const windowLabel = resolveSecondaryWindowLabel({
      windowHours: Math.round(limitSeconds / 3600),
      primaryResetAt: readFiniteNumber(primary?.reset_at),
      secondaryResetAt: resetAt,
    });
    windows.push({
      ...windowFields(windowLabel),
      usedPercent: clampPercent(readFiniteNumber(secondary.used_percent) ?? 0),
      resetAt: resetAt ? resetAt * 1000 : undefined,
    });
  }
}

export async function fetchCodexUsage(
  token: string,
  accountId: string | undefined,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const version = process.env.OPENCLAW_VERSION?.trim();
  const defaultHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": `openclaw/${version || "dev"}`,
  };
  if (accountId) {
    defaultHeaders["ChatGPT-Account-Id"] = accountId;
  }
  const headers =
    resolveProviderRequestHeaders({
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/wham/usage",
      capability: "other",
      transport: "http",
      defaultHeaders,
    }) ?? defaultHeaders;

  const parsed = await fetchUsageJson({
    provider: "openai",
    url: "https://chatgpt.com/backend-api/wham/usage",
    init: { method: "GET", headers },
    timeoutMs,
    fetchFn,
    tokenExpiredStatuses: [401, 403],
  });
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const data = asNonArrayRecord(parsed.data);
  const windows: UsageWindow[] = [];
  appendRateLimitWindows(windows, data.rate_limit);
  const additionalRateLimits = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
    : [];
  for (const rawAdditional of additionalRateLimits) {
    const additional = asOptionalRecord(rawAdditional);
    if (!additional) {
      continue;
    }
    const limitName = typeof additional.limit_name === "string" ? additional.limit_name : undefined;
    const meteredFeature =
      typeof additional.metered_feature === "string" ? additional.metered_feature : undefined;
    appendRateLimitWindows(
      windows,
      additional.rate_limit,
      resolveAdditionalRateLimitLabel(limitName, meteredFeature),
    );
  }

  const plan = typeof data.plan_type === "string" ? data.plan_type : undefined;
  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  const balanceValue = asOptionalRecord(data.credits)?.balance;
  if (balanceValue !== undefined && balanceValue !== null) {
    const balance = readProviderNumber(balanceValue);
    if (balance !== undefined && balance >= 0) {
      billing.push({ type: "balance", amount: balance, unit: "credits" });
    }
  }

  const spendControl = asOptionalRecord(data.spend_control);
  const individualLimit = asOptionalRecord(spendControl?.individual_limit);
  if (individualLimit) {
    const reached = spendControl?.reached === true;
    const usedPercent = readFiniteNumber(individualLimit.used_percent);
    const remainingPercent = readFiniteNumber(individualLimit.remaining_percent);
    const resetAtSeconds = readFiniteNumber(individualLimit.reset_at);
    const resetAt = resetAtSeconds ? resetAtSeconds * 1000 : undefined;
    windows.push({
      label: "Monthly spend",
      usedPercent: reached
        ? 100
        : clampPercent(
            usedPercent ?? (remainingPercent === undefined ? 0 : 100 - remainingPercent),
          ),
      resetAt,
    });
    const used = readProviderNumber(individualLimit.used);
    const limit = readProviderNumber(individualLimit.limit);
    if (used !== undefined && used >= 0 && limit !== undefined && limit >= 0) {
      billing.push({
        type: "budget",
        label: "Monthly spend limit",
        used,
        limit,
        unit: "credits",
        period: "monthly",
        ...(resetAt ? { resetAt } : {}),
      });
    }
  }

  const summary =
    rateLimitReachedSummary(data.rate_limit_reached_type) ??
    (spendControl?.reached === true ? "Monthly spend limit reached" : undefined);

  return {
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    plan,
    ...(billing.length ? { billing } : {}),
    ...(summary ? { summary } : {}),
  };
}
