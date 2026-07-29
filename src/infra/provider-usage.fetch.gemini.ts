import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Fetches Gemini provider usage windows.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  buildUsageHttpErrorSnapshot,
  discardUsageResponseBody,
  fetchJson,
  readUsageJson,
} from "./provider-usage.fetch.shared.js";
import { clampPercent, providerUsageLabel } from "./provider-usage.shared.js";
import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

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
    await discardUsageResponseBody(res);
    return buildUsageHttpErrorSnapshot({
      provider,
      status: res.status,
    });
  }

  const parsed = await readUsageJson(provider, res);
  if (!parsed.ok) {
    return parsed.snapshot;
  }
  const buckets =
    isRecord(parsed.data) && Array.isArray(parsed.data.buckets) ? parsed.data.buckets : [];
  const quotas = new Map<string, number>();
  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    const model = typeof bucket.modelId === "string" ? bucket.modelId : "unknown";
    const frac = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 1;
    const current = quotas.get(model);
    if (current === undefined || frac < current) {
      quotas.set(model, frac);
    }
  }

  const windows: UsageWindow[] = [];
  let proMin = 1;
  let flashMin = 1;
  let hasPro = false;
  let hasFlash = false;

  for (const [model, frac] of quotas) {
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

  return {
    provider,
    displayName: expectDefined(providerUsageLabel(provider), "gemini provider usage label"),
    windows,
  };
}
