import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeClawRouterRootUrl } from "./provider-catalog.js";

const CLAWROUTER_USAGE_RESPONSE_MAX_BYTES = 1024 * 1024;

export type ClawRouterUsageFetchGuard = typeof fetchWithSsrFGuard;

type ClawRouterBudget = {
  configured?: unknown;
  ledger?: unknown;
  windowKey?: unknown;
  limitMicros?: unknown;
  spentMicros?: unknown;
  remainingMicros?: unknown;
};

type ClawRouterUsagePayload = {
  budget?: ClawRouterBudget;
  usage?: {
    summary?: {
      requestCount?: unknown;
      totalTokens?: unknown;
      actualCostMicros?: unknown;
    };
  };
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatUsd(micros: number): string {
  const dollars = micros / 1_000_000;
  return dollars < 0.01 && dollars > 0 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function resolveMonthlyResetAt(windowKey: unknown): number | undefined {
  if (typeof windowKey !== "string") {
    return undefined;
  }
  const match = windowKey.match(/\/(\d{4})-(\d{2})$/u);
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return Number.isSafeInteger(year) && month >= 1 && month <= 12
    ? Date.UTC(year, month, 1)
    : undefined;
}

function buildSummary(payload: ClawRouterUsagePayload): string | undefined {
  const summary = payload.usage?.summary;
  const requests = nonNegativeNumber(summary?.requestCount);
  const tokens = nonNegativeNumber(summary?.totalTokens);
  const costMicros = nonNegativeNumber(summary?.actualCostMicros);
  const parts = [
    requests === undefined ? undefined : `${formatCount(requests)} requests`,
    tokens === undefined ? undefined : `${formatCount(tokens)} tokens`,
    costMicros === undefined ? undefined : `${formatUsd(costMicros)} used`,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function readClawRouterUsagePayload(
  response: Response,
  timeoutMs: number,
): Promise<ClawRouterUsagePayload> {
  const buffer = await readResponseWithLimit(response, CLAWROUTER_USAGE_RESPONSE_MAX_BYTES, {
    chunkTimeoutMs: timeoutMs,
    onOverflow: ({ maxBytes }) => new Error(`ClawRouter usage response exceeds ${maxBytes} bytes`),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`ClawRouter usage response stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  return JSON.parse(new TextDecoder().decode(buffer)) as ClawRouterUsagePayload;
}

export async function fetchClawRouterUsage(params: {
  token: string;
  baseUrl?: string;
  timeoutMs: number;
  /** Test-only seam; production keeps the shared SSRF guard owning transport. */
  fetchGuard?: ClawRouterUsageFetchGuard;
}): Promise<ProviderUsageSnapshot> {
  // Operator-configured baseUrl can redirect anywhere. The guard owns transport and
  // rechecks every hop; env proxy mode preserves provider-usage proxy support while
  // direct and NO_PROXY requests retain pinned DNS.
  const rootUrl = normalizeClawRouterRootUrl(params.baseUrl);
  const fetchGuard = params.fetchGuard ?? fetchWithSsrFGuard;
  const { response, release } = await fetchGuard(
    withTrustedEnvProxyGuardedFetchMode({
      url: `${rootUrl}/v1/usage`,
      init: {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.token}`,
        },
      },
      timeoutMs: params.timeoutMs,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(rootUrl),
      auditContext: "clawrouter.usage",
    }),
  );
  try {
    if (!response.ok) {
      throw new Error(`ClawRouter usage request failed (HTTP ${response.status})`);
    }
    const payload = await readClawRouterUsagePayload(response, params.timeoutMs);
    const budget = payload.budget;
    const limitMicros = nonNegativeNumber(budget?.limitMicros);
    const spentMicros = nonNegativeNumber(budget?.spentMicros);
    const costMicros = nonNegativeNumber(payload.usage?.summary?.actualCostMicros);
    const resetAt = resolveMonthlyResetAt(budget?.windowKey);
    const windows = [];
    if (budget?.configured === true && limitMicros !== undefined && spentMicros !== undefined) {
      windows.push({
        label: "Monthly budget",
        usedPercent: limitMicros === 0 ? 100 : Math.min(100, (spentMicros / limitMicros) * 100),
        resetAt,
      });
    }
    const billing: ProviderUsageSnapshot["billing"] =
      budget?.configured === true && limitMicros !== undefined && spentMicros !== undefined
        ? [
            {
              type: "budget",
              used: spentMicros / 1_000_000,
              limit: limitMicros / 1_000_000,
              unit: "USD",
              period: "month",
              resetAt,
            },
          ]
        : costMicros !== undefined
          ? [{ type: "spend", amount: costMicros / 1_000_000, unit: "USD" }]
          : undefined;
    return {
      provider: "clawrouter" as ProviderUsageSnapshot["provider"],
      displayName: "ClawRouter",
      windows,
      ...(billing ? { billing } : {}),
      summary: buildSummary(payload),
      plan: budget?.configured === true ? "Managed monthly budget" : "Unmetered proxy key",
    };
  } finally {
    await release();
  }
}
