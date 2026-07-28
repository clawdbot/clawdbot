import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { buildUsageHttpErrorSnapshot } from "openclaw/plugin-sdk/provider-usage";

const OPENROUTER_USAGE_RESPONSE_MAX_BYTES = 1024 * 1024;
const OPENROUTER_API_ROOT = "https://openrouter.ai/api/v1";

type OpenRouterCreditsData = {
  total_credits?: unknown;
  total_usage?: unknown;
};

type OpenRouterKeyData = {
  label?: unknown;
  limit?: unknown;
  limit_remaining?: unknown;
  limit_reset?: unknown;
  usage?: unknown;
  usage_daily?: unknown;
  usage_weekly?: unknown;
  usage_monthly?: unknown;
  byok_usage_daily?: unknown;
  byok_usage_weekly?: unknown;
  byok_usage_monthly?: unknown;
  include_byok_in_limit?: unknown;
};

type EndpointResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number }
  | { ok: false; reason: "malformed" | "transport" };

type OpenRouterLimitReset = "daily" | "weekly" | "monthly";

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveLimitReset(value: unknown): OpenRouterLimitReset | undefined {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : undefined;
}

function resolveKeyBudget(
  data: OpenRouterKeyData | undefined,
): { used: number; limit: number; period?: OpenRouterLimitReset } | undefined {
  const limit = nonNegativeNumber(data?.limit);
  if (limit === undefined) {
    return undefined;
  }
  const period = resolveLimitReset(data?.limit_reset);
  const periodUsage =
    period === "daily"
      ? nonNegativeNumber(data?.usage_daily)
      : period === "weekly"
        ? nonNegativeNumber(data?.usage_weekly)
        : period === "monthly"
          ? nonNegativeNumber(data?.usage_monthly)
          : nonNegativeNumber(data?.usage);
  const remaining = nonNegativeNumber(data?.limit_remaining);
  // `limit_remaining` already incorporates BYOK usage when the key is configured to count it.
  const used = remaining === undefined ? periodUsage : Math.max(0, limit - remaining);
  return used === undefined ? undefined : { used, limit, ...(period ? { period } : {}) };
}

async function readJson(response: Response, timeoutMs: number): Promise<unknown> {
  return await readProviderJsonResponse(response, "OpenRouter usage", {
    maxBytes: OPENROUTER_USAGE_RESPONSE_MAX_BYTES,
    chunkTimeoutMs: timeoutMs,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`OpenRouter usage response stalled for ${chunkTimeoutMs}ms`),
  });
}

async function fetchEndpoint(params: {
  path: "credits" | "key";
  token: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<EndpointResult> {
  let response: Response;
  try {
    response = await params.fetchFn(`${OPENROUTER_API_ROOT}/${params.path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch {
    return { ok: false, reason: "transport" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, status: response.status };
  }
  try {
    const root = objectRecord(await readJson(response, params.timeoutMs));
    const data = objectRecord(root?.data);
    return data ? { ok: true, data } : { ok: false, reason: "malformed" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

export async function fetchOpenRouterUsage(params: {
  token: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const [creditsResult, keyResult] = await Promise.all([
    fetchEndpoint({ ...params, path: "credits" }),
    fetchEndpoint({ ...params, path: "key" }),
  ]);
  if (!creditsResult.ok && !keyResult.ok) {
    const status =
      "status" in creditsResult
        ? creditsResult.status
        : "status" in keyResult
          ? keyResult.status
          : undefined;
    if (status !== undefined) {
      return buildUsageHttpErrorSnapshot({ provider: "openrouter", status });
    }
    const transportFailed = [creditsResult, keyResult].some(
      (result) => "reason" in result && result.reason === "transport",
    );
    return {
      provider: "openrouter",
      displayName: "OpenRouter",
      windows: [],
      error: transportFailed ? "Usage unavailable" : "Malformed usage response",
    };
  }

  const credits = creditsResult.ok ? (creditsResult.data as OpenRouterCreditsData) : undefined;
  const key = keyResult.ok ? (keyResult.data as OpenRouterKeyData) : undefined;
  const totalCredits = nonNegativeNumber(credits?.total_credits);
  const totalUsage = nonNegativeNumber(credits?.total_usage);
  const keyUsage = nonNegativeNumber(key?.usage);
  const keyBudget = resolveKeyBudget(key);
  const windows = [];
  if (keyBudget) {
    const periodLabel = keyBudget.period
      ? `${keyBudget.period[0]?.toUpperCase()}${keyBudget.period.slice(1)} key budget`
      : "API key budget";
    windows.push({
      label: periodLabel,
      usedPercent:
        keyBudget.limit === 0 ? 100 : Math.min(100, (keyBudget.used / keyBudget.limit) * 100),
    });
  }

  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  if (totalCredits !== undefined && totalUsage !== undefined) {
    billing.push({
      type: "balance",
      label: "Account balance",
      amount: totalCredits - totalUsage,
      unit: "USD",
    });
    billing.push({
      type: "spend",
      label: "Account usage",
      amount: totalUsage,
      unit: "USD",
    });
  }
  if (keyBudget) {
    billing.push({
      type: "budget",
      label: "API key budget",
      used: keyBudget.used,
      limit: keyBudget.limit,
      unit: "USD",
      ...(keyBudget.period ? { period: keyBudget.period } : {}),
    });
  } else if (keyUsage !== undefined) {
    billing.push({
      type: "spend",
      label: "API key usage",
      amount: keyUsage,
      unit: "USD",
    });
  }

  const keyLabel = typeof key?.label === "string" ? key.label.trim() : "";
  const periodUsage = [
    ["today", nonNegativeNumber(key?.usage_daily)],
    ["this week", nonNegativeNumber(key?.usage_weekly)],
    ["this month", nonNegativeNumber(key?.usage_monthly)],
  ] as const;
  const summary = periodUsage
    .flatMap(([period, amount]) =>
      amount === undefined ? [] : [`$${amount.toFixed(2)} ${period}`],
    )
    .join(" · ");

  return {
    provider: "openrouter",
    displayName: "OpenRouter",
    windows,
    ...(billing.length > 0 ? { billing } : {}),
    ...(summary ? { summary } : {}),
    ...(keyLabel ? { plan: keyLabel } : {}),
  };
}
