// xAI plugin module implements SuperGrok provider usage behavior.
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildUsageHttpErrorSnapshot,
  clampPercent,
  fetchJson,
  type ProviderUsageBilling,
  type ProviderUsageSnapshot,
  type UsageWindow,
} from "openclaw/plugin-sdk/provider-usage";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const XAI_PROVIDER_ID = "xai";
const SUPERGROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUPERGROK_CLIENT_MODE = "cli";
const SUPERGROK_CLIENT_VERSION = "1.0.4";
const MAX_PLAN_CHARS = 128;
const MAX_EXACT_INTEGER = 9_007_199_254_740_991;

type BillingPeriod = {
  type?: unknown;
  end?: unknown;
};
type BillingConfig = Record<string, unknown>;

function parseCentValue(value: unknown): number | undefined {
  const raw = asOptionalRecord(value)?.val;
  if (raw === undefined || raw === null) {
    return 0;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return undefined;
}

function parseMoneyValue(value: unknown): number | undefined {
  const cents = parseCentValue(value);
  if (cents === undefined || cents < 0 || cents > MAX_EXACT_INTEGER) {
    return undefined;
  }
  return cents / 100;
}

function parsePlan(value: unknown): string | undefined {
  const plan = normalizeOptionalString(value);
  if (!plan || plan.length > MAX_PLAN_CHARS || hasControlCharacter(plan)) {
    return undefined;
  }
  return plan;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) {
      return true;
    }
  }
  return false;
}

function parseResetAt(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function parsePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return clampPercent(value);
}

function parseCurrentPeriod(value: unknown): BillingPeriod | undefined {
  const period = asOptionalRecord(value);
  return period
    ? {
        type: period.type,
        end: period.end,
      }
    : undefined;
}

function resolveUsageWindow(config: BillingConfig): UsageWindow | undefined {
  const currentPeriod = parseCurrentPeriod(config["currentPeriod"] ?? config["current_period"]);
  const explicitPercent = parsePercent(
    config["creditUsagePercent"] ?? config["credit_usage_percent"],
  );
  const used = parseCentValue(config["used"]);
  const monthlyLimit = parseCentValue(config["monthlyLimit"] ?? config["monthly_limit"]);
  const legacyPercent =
    used !== undefined && monthlyLimit !== undefined && monthlyLimit > 0 && used >= 0
      ? parsePercent((used / monthlyLimit) * 100)
      : undefined;
  const percent = explicitPercent ?? legacyPercent;
  if (percent === undefined) {
    return undefined;
  }

  const periodType = normalizeOptionalString(currentPeriod?.type) ?? "";
  const label = periodType.endsWith("WEEKLY")
    ? "Weekly"
    : periodType.endsWith("MONTHLY") ||
        monthlyLimit !== undefined ||
        config["billingPeriodEnd"] !== undefined ||
        config["billing_period_end"] !== undefined
      ? "Monthly"
      : "Usage";
  const resetAt = parseResetAt(
    currentPeriod?.end ?? config["billingPeriodEnd"] ?? config["billing_period_end"],
  );
  return {
    label,
    usedPercent: percent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function resolveBilling(config: BillingConfig): ProviderUsageBilling[] | undefined {
  const prepaid = parseMoneyValue(config["prepaidBalance"] ?? config["prepaid_balance"]);
  if (prepaid === undefined) {
    return undefined;
  }
  return [
    {
      type: "balance",
      label: "Prepaid balance",
      amount: prepaid,
      unit: "USD",
    },
  ];
}

function buildSuperGrokUsageSnapshot(data: unknown): ProviderUsageSnapshot {
  const payload = asOptionalRecord(data);
  const config = asOptionalRecord(payload?.["config"]);
  if (!config) {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [],
      error: "Malformed billing response",
    };
  }

  const window = resolveUsageWindow(config);
  if (!window) {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [],
      error: "No usage data",
    };
  }

  return {
    provider: XAI_PROVIDER_ID,
    displayName: "SuperGrok",
    windows: [window],
    billing: resolveBilling(config),
    plan: parsePlan(payload?.["subscription_tier"] ?? payload?.["subscriptionTier"]) ?? "SuperGrok",
  };
}

export async function fetchXaiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const response = await fetchJson(
    SUPERGROK_BILLING_URL,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "x-grok-client-mode": SUPERGROK_CLIENT_MODE,
        "x-grok-client-version": SUPERGROK_CLIENT_VERSION,
      },
    },
    timeoutMs,
    fetchFn,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return buildUsageHttpErrorSnapshot({
      provider: XAI_PROVIDER_ID,
      status: response.status,
      tokenExpiredStatuses: [401, 403],
    });
  }

  try {
    return buildSuperGrokUsageSnapshot(
      await readProviderJsonResponse<unknown>(response, "xai-usage"),
    );
  } catch {
    return {
      provider: XAI_PROVIDER_ID,
      displayName: "SuperGrok",
      windows: [],
      error: "Malformed billing response",
    };
  }
}
