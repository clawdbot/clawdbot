// Fetches Claude provider usage windows.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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

type NormalizedClaudeExtraUsage = {
  enabled: boolean;
  monthlyLimit?: number;
  usedCredits?: number;
  utilization?: number;
  currency?: string;
};

type NormalizedClaudeUsage = {
  data: Record<string, unknown>;
  extraUsage?: NormalizedClaudeExtraUsage;
};

function normalizeClaudeUsage(value: unknown): NormalizedClaudeUsage {
  const data = isRecord(value) ? value : {};
  const rawExtraUsage = isRecord(data.extra_usage) ? data.extra_usage : undefined;
  const extraUsage = rawExtraUsage
    ? {
        enabled: rawExtraUsage.is_enabled === true,
        monthlyLimit: asFiniteNumber(rawExtraUsage.monthly_limit),
        usedCredits: asFiniteNumber(rawExtraUsage.used_credits),
        utilization: asFiniteNumber(rawExtraUsage.utilization),
        currency: normalizeOptionalString(rawExtraUsage.currency),
      }
    : undefined;
  return { data, extraUsage };
}

function readClaudeWindow(
  data: Record<string, unknown>,
  key: string,
  label: string,
): UsageWindow | undefined {
  const rawWindow = isRecord(data[key]) ? data[key] : undefined;
  const utilization = asFiniteNumber(rawWindow?.utilization);
  if (utilization === undefined) {
    return undefined;
  }
  return {
    label,
    usedPercent: clampPercent(utilization),
    ...(key === "five_hour" || key === "seven_day"
      ? { resetAt: parseUsageResetAt(rawWindow?.resets_at) }
      : {}),
  };
}

function buildClaudeUsageWindows(
  usage: NormalizedClaudeUsage,
  options?: { skipExtraUsage?: boolean },
): UsageWindow[] {
  const { data, extraUsage } = usage;
  const windows: UsageWindow[] = [];

  const fiveHour = readClaudeWindow(data, "five_hour", "5h");
  if (fiveHour) {
    windows.push(fiveHour);
  }

  const sevenDay = readClaudeWindow(data, "seven_day", "Week");
  if (sevenDay) {
    windows.push(sevenDay);
  }

  const modelWindow =
    readClaudeWindow(data, "seven_day_sonnet", "Sonnet") ??
    readClaudeWindow(data, "seven_day_opus", "Opus");
  if (modelWindow) {
    windows.push(modelWindow);
  }

  const knownLabels = new Set(windows.map((window) => window.label.toLowerCase()));
  const limits = Array.isArray(data.limits) ? data.limits : [];
  for (const rawLimit of limits) {
    if (!isRecord(rawLimit)) {
      continue;
    }
    const percent = asFiniteNumber(rawLimit.percent);
    if (rawLimit.is_active === false || percent === undefined) {
      continue;
    }
    const scope = isRecord(rawLimit.scope) ? rawLimit.scope : undefined;
    const model = scope && isRecord(scope.model) ? scope.model : undefined;
    const label =
      normalizeOptionalString(model?.display_name) ?? normalizeOptionalString(model?.id);
    if (!label || knownLabels.has(label.toLowerCase())) {
      continue;
    }
    knownLabels.add(label.toLowerCase());
    windows.push({
      label,
      usedPercent: clampPercent(percent),
      resetAt: parseUsageResetAt(rawLimit.resets_at),
    });
  }

  // Skipped when the caller also emits an extra-usage budget billing entry;
  // rendering both would duplicate the same credits as window and budget.
  if (
    !options?.skipExtraUsage &&
    extraUsage?.enabled === true &&
    extraUsage.utilization !== undefined
  ) {
    windows.push({
      label: "Extra usage",
      usedPercent: clampPercent(extraUsage.utilization),
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
  const firstOrg = Array.isArray(parsedOrgs.data) ? parsedOrgs.data[0] : undefined;
  const orgId = isRecord(firstOrg) ? normalizeOptionalString(firstOrg.uuid) : undefined;
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
  const usage = normalizeClaudeUsage(parsedUsage.data);
  const windows = buildClaudeUsageWindows(usage);

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
  const usage = normalizeClaudeUsage(parsed.data);
  const extra = usage.extraUsage;
  const unit = extra?.currency?.toUpperCase() || "USD";
  const billing =
    extra?.enabled === true &&
    extra.usedCredits !== undefined &&
    extra.usedCredits >= 0 &&
    extra.monthlyLimit !== undefined &&
    extra.monthlyLimit >= 0
      ? [
          {
            type: "budget" as const,
            // Anthropic reports extra-usage currency in minor units.
            used: extra.usedCredits / 100,
            limit: extra.monthlyLimit / 100,
            unit,
            period: "month",
          },
        ]
      : undefined;
  const windows = buildClaudeUsageWindows(usage, { skipExtraUsage: Boolean(billing) });

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
    ...(billing ? { billing } : {}),
  };
}
