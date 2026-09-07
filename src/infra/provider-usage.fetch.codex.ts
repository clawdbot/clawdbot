import {
  asFiniteNumber,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// Fetches Codex provider usage windows.
import { resolveProviderRequestHeaders } from "../agents/provider-request-config.js";
import { fetchUsageJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;

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
  const rateLimit = asOptionalRecord(data.rate_limit);
  const primary = asOptionalRecord(rateLimit?.primary_window);
  if (primary) {
    const resetAt = asFiniteNumber(primary.reset_at);
    const minutes = Math.round((asFiniteNumber(primary.limit_window_seconds) ?? 10_800) / 60);
    windows.push({
      label: minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`,
      usedPercent: clampPercent(asFiniteNumber(primary.used_percent) ?? 0),
      resetAt: resetAt ? resetAt * 1000 : undefined,
    });
  }
  const secondary = asOptionalRecord(rateLimit?.secondary_window);
  if (secondary) {
    const resetAt = asFiniteNumber(secondary.reset_at);
    windows.push({
      label: resolveSecondaryWindowLabel({
        windowHours: Math.round((asFiniteNumber(secondary.limit_window_seconds) ?? 86_400) / 3600),
        primaryResetAt: asFiniteNumber(primary?.reset_at),
        secondaryResetAt: resetAt,
      }),
      usedPercent: clampPercent(asFiniteNumber(secondary.used_percent) ?? 0),
      resetAt: resetAt ? resetAt * 1000 : undefined,
    });
  }

  const plan = typeof data.plan_type === "string" ? data.plan_type : undefined;
  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  const balanceValue = asOptionalRecord(data.credits)?.balance;
  if (balanceValue !== undefined && balanceValue !== null) {
    const balance = parseStrictFiniteNumber(balanceValue);
    if (balance !== undefined && balance >= 0) {
      billing.push({ type: "balance", amount: balance, unit: "credits" });
    }
  }

  return {
    provider: "openai",
    displayName: PROVIDER_LABELS.openai,
    windows,
    plan,
    ...(billing.length ? { billing } : {}),
  };
}
