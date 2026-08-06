import type { RuntimeId, RuntimeParityUsage } from "./runtime-parity.js";

export type QaRuntimeParityCacheUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  grossInputTokens: number | null;
  uncachedInputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheHitPercent: number | null;
};

type QaRuntimeParityCacheScenario = {
  openclawUsage: QaRuntimeParityCacheUsage | null;
  codexUsage: QaRuntimeParityCacheUsage | null;
};

export function summarizeRuntimeParityCacheUsage(
  usage: Pick<
    RuntimeParityUsage,
    "inputTokens" | "outputTokens" | "totalTokens" | "cacheRead" | "cacheWrite"
  >,
): QaRuntimeParityCacheUsage {
  const cachedInputTokens = usage.cacheRead ?? null;
  const cacheWriteTokens = usage.cacheWrite ?? null;
  const uncachedInputTokens =
    cacheWriteTokens === null ? null : usage.inputTokens + cacheWriteTokens;
  const grossInputTokens =
    cachedInputTokens === null || uncachedInputTokens === null
      ? null
      : uncachedInputTokens + cachedInputTokens;
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    grossInputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cacheHitPercent:
      grossInputTokens !== null && grossInputTokens > 0 && cachedInputTokens !== null
        ? (cachedInputTokens / grossInputTokens) * 100
        : null,
  };
}

export function aggregateRuntimeParityCacheUsage(
  scenarios: readonly QaRuntimeParityCacheScenario[],
  runtime: RuntimeId,
): QaRuntimeParityCacheUsage | null {
  const captures = scenarios.flatMap((scenario) => {
    const usage = runtime === "openclaw" ? scenario.openclawUsage : scenario.codexUsage;
    return usage === null ? [] : [usage];
  });
  if (captures.length === 0) {
    return null;
  }
  const measuredCaptures = captures.filter(
    (capture) => capture.cachedInputTokens !== null && capture.cacheWriteTokens !== null,
  );
  const inputTokens = captures.reduce((total, capture) => total + capture.inputTokens, 0);
  const outputTokens = captures.reduce((total, capture) => total + capture.outputTokens, 0);
  const totalTokens = captures.reduce((total, capture) => total + capture.totalTokens, 0);
  if (measuredCaptures.length === 0) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      grossInputTokens: null,
      uncachedInputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      cacheHitPercent: null,
    };
  }
  const cachedInputTokens = measuredCaptures.reduce(
    (total, capture) => total + (capture.cachedInputTokens ?? 0),
    0,
  );
  const cacheWriteTokens = measuredCaptures.reduce(
    (total, capture) => total + (capture.cacheWriteTokens ?? 0),
    0,
  );
  const uncachedInputTokens = measuredCaptures.reduce(
    (total, capture) => total + capture.inputTokens + (capture.cacheWriteTokens ?? 0),
    0,
  );
  const grossInputTokens = uncachedInputTokens + cachedInputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    grossInputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cacheHitPercent: grossInputTokens > 0 ? (cachedInputTokens / grossInputTokens) * 100 : null,
  };
}

export function formatRuntimeCacheHitPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : `${value.toFixed(1)}%`;
}

export function formatRuntimeCacheCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : String(value);
}
