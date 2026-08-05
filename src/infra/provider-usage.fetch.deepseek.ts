// Fetches and normalizes DeepSeek provider usage records.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  parseFiniteNumber,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

type DeepSeekBalanceInfo = {
  currency?: string;
  total_balance?: string | number | null;
  granted_balance?: string | number | null;
  topped_up_balance?: string | number | null;
};

type DeepSeekBalanceResponse = {
  is_available?: boolean;
  balance_infos?: DeepSeekBalanceInfo[];
};

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

function formatCurrencyAmount(amount: number, currency?: string): string {
  const normalized = currency?.trim().toUpperCase();
  if (normalized === "CNY" || normalized === "RMB") {
    return `¥${amount.toFixed(2)}`;
  }
  if (normalized === "USD") {
    return `$${amount.toFixed(2)}`;
  }
  return normalized ? `${amount.toFixed(2)} ${normalized}` : amount.toFixed(2);
}

function parseBalanceAmount(value: unknown): number | undefined {
  return parseFiniteNumber(value);
}

function buildBalanceSummary(info: DeepSeekBalanceInfo): string | undefined {
  const total = parseBalanceAmount(info.total_balance);
  if (total === undefined) {
    return undefined;
  }
  const granted = parseBalanceAmount(info.granted_balance);
  const toppedUp = parseBalanceAmount(info.topped_up_balance);
  const parts = [`Balance ${formatCurrencyAmount(total, info.currency)}`];
  if (granted !== undefined && granted > 0) {
    parts.push(`Granted ${formatCurrencyAmount(granted, info.currency)}`);
  }
  if (toppedUp !== undefined && toppedUp > 0 && toppedUp !== total) {
    parts.push(`Topped up ${formatCurrencyAmount(toppedUp, info.currency)}`);
  }
  return parts.join(" · ");
}

export async function fetchDeepSeekUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    DEEPSEEK_BALANCE_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    await discardUsageResponseBody(res);
    return buildUsageHttpErrorSnapshot({
      provider: "deepseek",
      status: res.status,
    });
  }

  const parsed = await readUsageJson("deepseek", res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }

  const data = isRecord(parsed.data) ? (parsed.data as DeepSeekBalanceResponse) : undefined;
  const balances = data && Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const summary = balances
    .map((info) => buildBalanceSummary(info))
    .filter((entry): entry is string => Boolean(entry))
    .join(" · ");
  const billing = balances.flatMap((info) => {
    const amount = parseBalanceAmount(info.total_balance);
    if (amount === undefined || amount < 0) {
      return [];
    }
    return [
      {
        type: "balance" as const,
        amount,
        unit: info.currency?.trim().toUpperCase() || "credits",
      },
    ];
  });
  if (!summary) {
    return {
      provider: "deepseek",
      displayName: PROVIDER_LABELS.deepseek,
      windows: [],
      error: "No balance data",
    };
  }

  return {
    provider: "deepseek",
    displayName: PROVIDER_LABELS.deepseek,
    windows: [],
    billing,
    summary,
    ...(data?.is_available === false ? { plan: "Unavailable" } : {}),
  };
}
