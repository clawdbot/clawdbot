import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { buildUsageHttpErrorSnapshot } from "openclaw/plugin-sdk/provider-usage";

const VENICE_BALANCE_URL = "https://api.venice.ai/api/v1/billing/balance";
const VENICE_USAGE_RESPONSE_MAX_BYTES = 1024 * 1024;

type VeniceBalanceResponse = {
  canConsume?: unknown;
  consumptionCurrency?: unknown;
  balances?: {
    diem?: unknown;
    usd?: unknown;
  };
  diemEpochAllocation?: unknown;
};

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readPayload(response: Response, timeoutMs: number): Promise<VeniceBalanceResponse> {
  const data = await readProviderJsonObjectResponse(response, "Venice usage", {
    maxBytes: VENICE_USAGE_RESPONSE_MAX_BYTES,
    chunkTimeoutMs: timeoutMs,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Venice usage response stalled for ${chunkTimeoutMs}ms`),
  });
  return data as VeniceBalanceResponse;
}

export async function fetchVeniceUsage(params: {
  token: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<ProviderUsageSnapshot> {
  let response: Response;
  try {
    response = await params.fetchFn(VENICE_BALANCE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch {
    return {
      provider: "venice",
      displayName: "Venice",
      windows: [],
      error: "Usage unavailable",
    };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({ provider: "venice", status: response.status });
  }

  let data: VeniceBalanceResponse;
  try {
    data = await readPayload(response, params.timeoutMs);
  } catch {
    return {
      provider: "venice",
      displayName: "Venice",
      windows: [],
      error: "Malformed usage response",
    };
  }

  const diem = nonNegativeNumber(data.balances?.diem);
  const usd = nonNegativeNumber(data.balances?.usd);
  const allocation = nonNegativeNumber(data.diemEpochAllocation);
  const windows = [];
  if (diem !== undefined && allocation !== undefined && allocation > 0) {
    windows.push({
      label: "DIEM epoch",
      usedPercent: Math.min(100, Math.max(0, ((allocation - diem) / allocation) * 100)),
    });
  }

  const billing: NonNullable<ProviderUsageSnapshot["billing"]> = [];
  if (diem !== undefined) {
    billing.push({ type: "balance", label: "DIEM balance", amount: diem, unit: "DIEM" });
  }
  if (usd !== undefined) {
    billing.push({ type: "balance", label: "USD balance", amount: usd, unit: "USD" });
  }
  if (diem !== undefined && allocation !== undefined && allocation > 0) {
    billing.push({
      type: "budget",
      label: "DIEM epoch",
      used: Math.max(0, allocation - diem),
      limit: allocation,
      unit: "DIEM",
      period: "epoch",
    });
  }

  const consumptionCurrency =
    typeof data.consumptionCurrency === "string"
      ? data.consumptionCurrency.trim().toUpperCase()
      : "";
  return {
    provider: "venice",
    displayName: "Venice",
    windows,
    ...(billing.length > 0 ? { billing } : {}),
    ...(consumptionCurrency ? { plan: `${consumptionCurrency} billing` } : {}),
    ...(data.canConsume === false ? { summary: "API consumption unavailable" } : {}),
  };
}
