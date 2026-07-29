// Fetches and normalizes Z.ai provider usage records.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  parseUsageResetAt,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageWindow } from "./provider-usage.types.js";

type NormalizedZaiLimit = {
  type?: string;
  percentage?: number;
  unit?: number;
  number?: number;
  nextResetTime?: string;
};

type NormalizedZaiUsage =
  | { ok: false; message?: string }
  | {
      ok: true;
      plan?: string;
      limits: NormalizedZaiLimit[];
    };

function normalizeZaiUsage(value: unknown): NormalizedZaiUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const message = normalizeOptionalString(value.msg);
  if (value.success !== true || asFiniteNumber(value.code) !== 200) {
    return { ok: false, message };
  }

  const data = isRecord(value.data) ? value.data : {};
  const rawLimits = Array.isArray(data.limits) ? data.limits : [];

  const limits: NormalizedZaiLimit[] = [];
  for (const rawLimit of rawLimits) {
    if (!isRecord(rawLimit)) {
      continue;
    }
    limits.push({
      type: normalizeOptionalString(rawLimit.type),
      percentage: asFiniteNumber(rawLimit.percentage),
      unit: asFiniteNumber(rawLimit.unit),
      number: asFiniteNumber(rawLimit.number),
      nextResetTime: normalizeOptionalString(rawLimit.nextResetTime),
    });
  }

  return {
    ok: true,
    plan: normalizeOptionalString(data.planName) ?? normalizeOptionalString(data.plan),
    limits,
  };
}

export async function fetchZaiUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.z.ai/api/monitor/usage/quota/limit",
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
      provider: "zai",
      status: res.status,
    });
  }

  const parsed = await readUsageJson("zai", res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const usage = normalizeZaiUsage(parsed.data);
  if (!usage || !usage.ok) {
    return {
      provider: "zai",
      displayName: PROVIDER_LABELS.zai,
      windows: [],
      error: usage?.message || "API error",
    };
  }

  const windows: UsageWindow[] = [];
  for (const limit of usage.limits) {
    const percent = clampPercent(limit.percentage ?? 0);
    const nextReset = parseUsageResetAt(limit.nextResetTime);
    let windowLabel = "Limit";
    if (limit.unit === 1 && limit.number !== undefined) {
      windowLabel = `${limit.number}d`;
    } else if (limit.unit === 3 && limit.number !== undefined) {
      windowLabel = `${limit.number}h`;
    } else if (limit.unit === 5 && limit.number !== undefined) {
      windowLabel = `${limit.number}m`;
    }

    if (limit.type === "TOKENS_LIMIT") {
      windows.push({
        label: `Tokens (${windowLabel})`,
        usedPercent: percent,
        resetAt: nextReset,
      });
    } else if (limit.type === "TIME_LIMIT") {
      windows.push({
        label: "Monthly",
        usedPercent: percent,
        resetAt: nextReset,
      });
    }
  }

  return {
    provider: "zai",
    displayName: PROVIDER_LABELS.zai,
    windows,
    plan: usage.plan,
  };
}
