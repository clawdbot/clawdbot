import {
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildUsageHttpErrorSnapshot,
  parseProviderUsageNonNegativeNumber,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  OPENROUTER_BASE_URL,
  resolveOpenRouterApiBaseUrl,
  resolveOpenRouterSsrfPolicy,
} from "./provider-catalog.js";

const OPENROUTER_USAGE_RESPONSE_MAX_BYTES = 1024 * 1024;

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
  byok_usage?: unknown;
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

function resolveLimitReset(value: unknown): OpenRouterLimitReset | undefined {
  return value === "daily" || value === "weekly" || value === "monthly" ? value : undefined;
}

function resolveKeyBudget(
  data: OpenRouterKeyData | undefined,
): { used: number; limit: number; period?: OpenRouterLimitReset } | undefined {
  const limit = parseProviderUsageNonNegativeNumber(data?.limit);
  if (limit === undefined) {
    return undefined;
  }
  const period = resolveLimitReset(data?.limit_reset);
  const periodUsage =
    period === "daily"
      ? parseProviderUsageNonNegativeNumber(data?.usage_daily)
      : period === "weekly"
        ? parseProviderUsageNonNegativeNumber(data?.usage_weekly)
        : period === "monthly"
          ? parseProviderUsageNonNegativeNumber(data?.usage_monthly)
          : parseProviderUsageNonNegativeNumber(data?.usage);
  const byokUsage =
    data?.include_byok_in_limit !== true
      ? undefined
      : period === "daily"
        ? parseProviderUsageNonNegativeNumber(data.byok_usage_daily)
        : period === "weekly"
          ? parseProviderUsageNonNegativeNumber(data.byok_usage_weekly)
          : period === "monthly"
            ? parseProviderUsageNonNegativeNumber(data.byok_usage_monthly)
            : parseProviderUsageNonNegativeNumber(data.byok_usage);
  const remaining = parseProviderUsageNonNegativeNumber(data?.limit_remaining);
  // `limit_remaining` already incorporates BYOK usage when the key is configured to count it.
  const usage =
    periodUsage === undefined && byokUsage === undefined
      ? undefined
      : (periodUsage ?? 0) + (byokUsage ?? 0);
  const used = remaining === undefined ? usage : Math.max(0, limit - remaining);
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
  baseUrl: string;
  headers: Headers;
  ssrfPolicy: ReturnType<typeof resolveOpenRouterSsrfPolicy>;
  dispatcherPolicy: ReturnType<typeof resolveProviderHttpRequestConfig>["dispatcherPolicy"];
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<EndpointResult> {
  let guardedResponse: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guardedResponse = await fetchWithSsrFGuard({
      url: `${params.baseUrl}/${params.path}`,
      // Ambient proxy fetch wrappers replace dispatchers, so configured provider transport wins.
      ...(params.dispatcherPolicy
        ? { dispatcherPolicy: params.dispatcherPolicy }
        : { fetchImpl: params.fetchFn }),
      init: {
        headers: params.headers,
        redirect: "error",
      },
      timeoutMs: params.timeoutMs,
      // The shared guard controls redirects manually; zero hops preserves fail-closed usage auth.
      maxRedirects: 0,
      policy: params.ssrfPolicy,
      auditContext: "openrouter-usage",
    });
  } catch {
    return { ok: false, reason: "transport" };
  }
  try {
    const { response } = guardedResponse;
    if (!response.ok) {
      // release() aborts transport before cancelling unread capture-tee bodies.
      // Awaiting one branch here can hold the error result until the other ends.
      return { ok: false, status: response.status };
    }
    try {
      const root = asOptionalRecord(await readJson(response, params.timeoutMs));
      const data = asOptionalRecord(root?.data);
      return data ? { ok: true, data } : { ok: false, reason: "malformed" };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  } finally {
    await guardedResponse.release();
  }
}

export async function fetchOpenRouterUsage(params: {
  token: string;
  baseUrl?: string;
  request?: ModelProviderConfig["request"];
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  const requestConfig = resolveProviderHttpRequestConfig({
    provider: "openrouter",
    capability: "other",
    baseUrl: resolveOpenRouterApiBaseUrl(params.baseUrl),
    defaultBaseUrl: OPENROUTER_BASE_URL,
    defaultHeaders: {
      Accept: "application/json",
      Authorization: `Bearer ${params.token}`,
    },
    request: sanitizeConfiguredModelProviderRequest(params.request),
  });
  const request = {
    baseUrl: requestConfig.baseUrl,
    headers: requestConfig.headers,
    ssrfPolicy: resolveOpenRouterSsrfPolicy(requestConfig, params.request),
    dispatcherPolicy: requestConfig.dispatcherPolicy,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  };
  const [creditsResult, keyResult] = await Promise.all([
    fetchEndpoint({ ...request, path: "credits" }),
    fetchEndpoint({ ...request, path: "key" }),
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
  const totalCredits = parseProviderUsageNonNegativeNumber(credits?.total_credits);
  const totalUsage = parseProviderUsageNonNegativeNumber(credits?.total_usage);
  const keyUsage = parseProviderUsageNonNegativeNumber(key?.usage);
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
    ["today", parseProviderUsageNonNegativeNumber(key?.usage_daily)],
    ["this week", parseProviderUsageNonNegativeNumber(key?.usage_weekly)],
    ["this month", parseProviderUsageNonNegativeNumber(key?.usage_monthly)],
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
