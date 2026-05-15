import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  buildUsageHttpErrorSnapshot,
  fetchJson,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

type GeminiUsageResponse = {
  buckets?: Array<{ modelId?: string; remainingFraction?: number }>;
};

export async function fetchGeminiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return buildUsageHttpErrorSnapshot({
      provider,
      status: res.status,
    });
  }

  const parsed = await readUsageJson(provider, res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const data = parsed.data as GeminiUsageResponse;
  const quotas: Record<string, number> = {};

  for (const bucket of data.buckets || []) {
    const model = bucket.modelId || "unknown";
    const frac = bucket.remainingFraction ?? 1;
    if (!quotas[model] || frac < quotas[model]) {
      quotas[model] = frac;
    }
  }

  const windows: UsageWindow[] = [];
  let proMin = 1;
  let flashMin = 1;
  let hasPro = false;
  let hasFlash = false;

  for (const [model, frac] of Object.entries(quotas)) {
    const lower = normalizeLowercaseStringOrEmpty(model);
    if (lower.includes("pro")) {
      hasPro = true;
      if (frac < proMin) {
        proMin = frac;
      }
    }
    if (lower.includes("flash")) {
      hasFlash = true;
      if (frac < flashMin) {
        flashMin = frac;
      }
    }
  }

  if (hasPro) {
    windows.push({
      label: "Pro",
      usedPercent: clampPercent((1 - proMin) * 100),
    });
  }
  if (hasFlash) {
    windows.push({
      label: "Flash",
      usedPercent: clampPercent((1 - flashMin) * 100),
    });
  }

  return { provider, displayName: PROVIDER_LABELS[provider], windows };
}
