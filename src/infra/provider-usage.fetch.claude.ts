// Fetches Claude provider usage windows.
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import {
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  parseUsageResetAt,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type ClaudeUsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
  limits?: Array<{
    percent?: number;
    resets_at?: string;
    is_active?: boolean;
    scope?: { model?: { id?: string; display_name?: string } };
  }>;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number;
    currency?: string;
  };
};

type ClaudeWebOrganizationsResponse = Array<{
  uuid?: string;
  name?: string;
}>;

function buildClaudeUsageWindows(
  data: ClaudeUsageResponse,
  options?: { skipExtraUsage?: boolean },
): UsageWindow[] {
  const windows: UsageWindow[] = [];

  if (data.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: parseUsageResetAt(data.five_hour.resets_at),
    });
  }

  if (data.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: parseUsageResetAt(data.seven_day.resets_at),
    });
  }

  const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
  if (modelWindow?.utilization !== undefined) {
    windows.push({
      label: data.seven_day_sonnet ? "Sonnet" : "Opus",
      usedPercent: clampPercent(modelWindow.utilization),
    });
  }

  const knownLabels = new Set(windows.map((window) => window.label.toLowerCase()));
  for (const limit of data.limits ?? []) {
    if (limit.is_active === false || !Number.isFinite(limit.percent)) {
      continue;
    }
    const model = limit.scope?.model;
    const label = model?.display_name?.trim() || model?.id?.trim();
    if (!label || knownLabels.has(label.toLowerCase())) {
      continue;
    }
    knownLabels.add(label.toLowerCase());
    windows.push({
      label,
      usedPercent: clampPercent(limit.percent ?? 0),
      resetAt: parseUsageResetAt(limit.resets_at),
    });
  }

  // Skipped when the caller also emits an extra-usage budget billing entry;
  // rendering both would duplicate the same credits as window and budget.
  if (
    !options?.skipExtraUsage &&
    data.extra_usage?.is_enabled &&
    Number.isFinite(data.extra_usage.utilization)
  ) {
    windows.push({
      label: "Extra usage",
      usedPercent: clampPercent(data.extra_usage.utilization ?? 0),
    });
  }

  return windows;
}

function resolveClaudeWebSessionKey(): string | undefined {
  const direct =
    process.env.CLAUDE_AI_SESSION_KEY?.trim() ?? process.env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) {
    return direct;
  }

  const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookieHeader) {
    return undefined;
  }
  const stripped = cookieHeader.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

async function fetchClaudeWebUsage(
  sessionKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot | null> {
  const headers: Record<string, string> = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  const orgRes = await fetchJson(
    "https://claude.ai/api/organizations",
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!orgRes.ok) {
    await discardUsageResponseBody(orgRes);
    return null;
  }

  const parsedOrgs = await readUsageJson("anthropic", orgRes);
  if (!parsedOrgs.ok) {
    return null;
  }
  const orgs = parsedOrgs.data as ClaudeWebOrganizationsResponse;
  const orgId = orgs?.[0]?.uuid?.trim();
  if (!orgId) {
    return null;
  }

  const usageRes = await fetchJson(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!usageRes.ok) {
    await discardUsageResponseBody(usageRes);
    return null;
  }

  const parsedUsage = await readUsageJson("anthropic", usageRes);
  if (!parsedUsage.ok) {
    return null;
  }
  const data = parsedUsage.data as ClaudeUsageResponse;
  const windows = buildClaudeUsageWindows(data);

  if (windows.length === 0) {
    return null;
  }
  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}

export async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "openclaw",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    let message: string | undefined;
    try {
      const data = await readProviderJsonResponse<{
        error?: { message?: unknown } | null;
      }>(res, "Anthropic usage error");
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    // Claude Code CLI setup-token yields tokens that can be used for inference, but may not
    // include user:profile scope required by the OAuth usage endpoint. When a claude.ai
    // browser sessionKey is available, fall back to the web API.
    if (res.status === 403 && message?.includes("scope requirement user:profile")) {
      const sessionKey = resolveClaudeWebSessionKey();
      if (sessionKey) {
        const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
        if (web) {
          return web;
        }
      }
    }

    return buildUsageHttpErrorSnapshot({
      provider: "anthropic",
      status: res.status,
      message,
    });
  }

  const parsed = await readUsageJson("anthropic", res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const data = parsed.data as ClaudeUsageResponse;
  const extra = data.extra_usage;
  const unit = extra?.currency?.trim().toUpperCase() || "USD";
  const billing =
    extra?.is_enabled === true &&
    typeof extra.used_credits === "number" &&
    Number.isFinite(extra.used_credits) &&
    extra.used_credits >= 0 &&
    typeof extra.monthly_limit === "number" &&
    Number.isFinite(extra.monthly_limit) &&
    extra.monthly_limit >= 0
      ? [
          {
            type: "budget" as const,
            // Anthropic reports extra-usage currency in minor units.
            used: extra.used_credits / 100,
            limit: extra.monthly_limit / 100,
            unit,
            period: "month",
          },
        ]
      : undefined;
  const windows = buildClaudeUsageWindows(data, { skipExtraUsage: Boolean(billing) });

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
    ...(billing ? { billing } : {}),
  };
}
