import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  LIVE_CACHE_REGRESSION_BASELINE,
  type LiveCacheFloor,
} from "./live-cache-regression-baseline.js";
import {
  isLiveCachePrerequisiteSkip,
  type LiveResolvedModelPool,
  logLiveCache,
  resolveLiveDirectModelPool,
} from "./live-cache-test-support.js";

const LIVE_CACHE_LANE_RETRIES = 1;
export const LIVE_CACHE_RESPONSE_RETRIES = 2;
const OPENAI_CACHE_PROBE_MIN_MAX_TOKENS = 1024;
const ANTHROPIC_CACHE_PROBE_MIN_MAX_TOKENS = 1024;

type LiveCacheProviderConfig = Parameters<typeof resolveLiveDirectModelPool>[0];
type ProviderKey = keyof typeof LIVE_CACHE_REGRESSION_BASELINE;
export type CacheLane = "image" | "mcp" | "stable" | "tool";
export type CacheUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};
type BaselineLane = CacheLane | "disabled";
export type CacheRun = {
  hitRate: number;
  suffix: string;
  text: string;
  usage: CacheUsage;
};
export type LaneResult = {
  best?: CacheRun;
  disabled?: CacheRun;
  warmup?: CacheRun;
};
export type BaselineFindings = {
  regressions: string[];
  warnings: string[];
};
type LiveCacheRegressionSummary = Record<string, Record<string, unknown>>;
type LiveCacheProviderResolver = (
  params: LiveCacheProviderConfig,
) => Promise<LiveResolvedModelPool>;

export async function resolveLiveCacheProviderPool(params: {
  config: LiveCacheProviderConfig;
  regressions: string[];
  resolver?: LiveCacheProviderResolver;
  summary: LiveCacheRegressionSummary;
  warnings: string[];
}): Promise<LiveResolvedModelPool | undefined> {
  try {
    return await (params.resolver ?? resolveLiveDirectModelPool)(params.config);
  } catch (error) {
    if (!isLiveCachePrerequisiteSkip(error)) {
      throw error;
    }
    const warning = `${error.provider} skipped: ${error.message}`;
    if (error.provider === "openai") {
      params.warnings.push(warning);
    } else {
      params.regressions.push(warning);
    }
    const providerSummary = params.summary[error.provider];
    if (providerSummary) {
      providerSummary.skipped = true;
    }
    logLiveCache(warning);
    return undefined;
  }
}

export function shouldRetryCacheProbeText(params: {
  attempt: number;
  suffix: string;
  text: string;
}): boolean {
  const responseTextLower = normalizeLowercaseStringOrEmpty(params.text);
  const suffixLower = normalizeLowercaseStringOrEmpty(params.suffix);
  const markerLower = `cache-ok ${suffixLower}`;
  // Live providers sometimes return near-miss text on the first attempt.
  return (
    (!responseTextLower.includes(markerLower) || !responseTextLower.includes(suffixLower)) &&
    params.attempt <= LIVE_CACHE_RESPONSE_RETRIES
  );
}

export function resolveCacheProbeMaxTokens(params: {
  maxTokens: number | undefined;
  providerTag: "anthropic" | "openai";
}): number {
  const requested = params.maxTokens ?? 64;
  const floor =
    params.providerTag === "anthropic"
      ? ANTHROPIC_CACHE_PROBE_MIN_MAX_TOKENS
      : OPENAI_CACHE_PROBE_MIN_MAX_TOKENS;
  return Math.max(requested, floor);
}

export function shouldAcceptEmptyCacheProbe(params: {
  providerTag: "anthropic" | "openai";
  text: string;
  usage: CacheUsage;
}): boolean {
  if (params.text.trim().length > 0) {
    return false;
  }
  // Empty text is acceptable only when provider usage proves the cache lane ran.
  return (
    (params.usage.input ?? 0) > 0 ||
    (params.usage.cacheRead ?? 0) > 0 ||
    (params.usage.cacheWrite ?? 0) > 0
  );
}

function resolveBaselineFloor(provider: ProviderKey, lane: string): LiveCacheFloor | undefined {
  return LIVE_CACHE_REGRESSION_BASELINE[provider][
    lane as keyof (typeof LIVE_CACHE_REGRESSION_BASELINE)[typeof provider]
  ] as LiveCacheFloor | undefined;
}

function warmupHasCacheEvidence(params: { floor: LiveCacheFloor; warmup: CacheRun }): boolean {
  const cacheRead = params.warmup.usage.cacheRead ?? 0;
  const cacheWrite = params.warmup.usage.cacheWrite ?? 0;
  if (params.floor.minCacheReadOrWrite !== undefined) {
    return Math.max(cacheRead, cacheWrite) >= params.floor.minCacheReadOrWrite;
  }
  if (params.floor.minCacheRead !== undefined && cacheRead < params.floor.minCacheRead) {
    return false;
  }
  if (params.floor.minHitRate !== undefined && params.warmup.hitRate < params.floor.minHitRate) {
    return false;
  }
  return params.floor.minCacheRead !== undefined || params.floor.minHitRate !== undefined;
}

export function assertAgainstBaseline(params: {
  lane: BaselineLane;
  provider: ProviderKey;
  result: LaneResult;
  regressions: string[];
  warnings: string[];
}): void {
  const floor = resolveBaselineFloor(params.provider, params.lane);
  const recordRegression = (message: string) => {
    // OpenAI cache floors are currently watch-only; Anthropic misses fail.
    if (floor?.warnOnly) {
      params.warnings.push(message);
    } else {
      params.regressions.push(message);
    }
  };
  if (!floor) {
    params.regressions.push(`${params.provider}:${params.lane} missing baseline entry`);
    return;
  }

  if (params.result.best) {
    const usage = params.result.best.usage;
    if (floor.minCacheReadOrWrite !== undefined) {
      const cacheReadOrWrite = Math.max(usage.cacheRead ?? 0, usage.cacheWrite ?? 0);
      if (cacheReadOrWrite < floor.minCacheReadOrWrite) {
        recordRegression(
          `${params.provider}:${params.lane} cacheReadOrWrite=${cacheReadOrWrite} < min=${floor.minCacheReadOrWrite}`,
        );
      }
    } else if ((usage.cacheRead ?? 0) < (floor.minCacheRead ?? 0)) {
      recordRegression(
        `${params.provider}:${params.lane} cacheRead=${usage.cacheRead ?? 0} < min=${floor.minCacheRead}`,
      );
    }
    if (params.result.best.hitRate < (floor.minHitRate ?? 0)) {
      recordRegression(
        `${params.provider}:${params.lane} hitRate=${params.result.best.hitRate.toFixed(3)} < min=${floor.minHitRate?.toFixed(3)}`,
      );
    }
  }

  if (params.result.warmup) {
    const warmup = params.result.warmup;
    const warmupUsage = warmup.usage;
    if (
      (warmupUsage.cacheWrite ?? 0) < (floor.minCacheWrite ?? 0) &&
      !warmupHasCacheEvidence({ floor, warmup })
    ) {
      recordRegression(
        `${params.provider}:${params.lane} warmup cacheWrite=${warmupUsage.cacheWrite ?? 0} < min=${floor.minCacheWrite}`,
      );
    }
  }

  if (params.result.disabled) {
    const usage = params.result.disabled.usage;
    if ((usage.cacheRead ?? 0) > (floor.maxCacheRead ?? Number.POSITIVE_INFINITY)) {
      recordRegression(
        `${params.provider}:${params.lane} cacheRead=${usage.cacheRead ?? 0} > max=${floor.maxCacheRead}`,
      );
    }
    if ((usage.cacheWrite ?? 0) > (floor.maxCacheWrite ?? Number.POSITIVE_INFINITY)) {
      recordRegression(
        `${params.provider}:${params.lane} cacheWrite=${usage.cacheWrite ?? 0} > max=${floor.maxCacheWrite}`,
      );
    }
  }
}

export function evaluateAgainstBaseline(params: {
  lane: BaselineLane;
  provider: ProviderKey;
  result: LaneResult;
}): BaselineFindings {
  const regressions: string[] = [];
  const warnings: string[] = [];
  assertAgainstBaseline({
    ...params,
    regressions,
    warnings,
  });
  return { regressions, warnings };
}

export function shouldRetryBaselineFindings(findings: BaselineFindings, attempt: number): boolean {
  return findings.regressions.length > 0 && attempt <= LIVE_CACHE_LANE_RETRIES;
}

export function isAnthropicToolProbeDrift(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.startsWith("expected tool call for ") ||
    error.message.startsWith("expected tool-only response for ")
  );
}
