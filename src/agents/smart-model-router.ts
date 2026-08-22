/**
 * Task-aware model routing primitives for Personal AI OS model policies.
 *
 * This module is intentionally provider-agnostic. Provider adapters should
 * supply the live catalog/health information; the router only ranks eligible
 * candidates and selects deterministic fallbacks.
 */

export type ModelRoutingPolicy = "free-only" | "free-first" | "best-available" | "manual";

export type ModelTask =
  | "chat"
  | "coding"
  | "debugging"
  | "reasoning"
  | "research"
  | "writing"
  | "summarization"
  | "vision"
  | "browser"
  | "tool-use"
  | "structured-output"
  | "long-context"
  | "fast"
  | "data-analysis"
  | "planning";

export type ModelFailureReason =
  | "rate-limit"
  | "quota"
  | "timeout"
  | "provider-error"
  | "context-length"
  | "tool-incompatible"
  | "authentication"
  | "permission"
  | "unknown";

export type SmartModelCandidate = {
  provider: string;
  model: string;
  free: boolean;
  available: boolean;
  capabilities: Partial<Record<ModelTask, number>>;
  contextWindow?: number;
  latencyMs?: number;
  successRate?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  cooldownUntil?: number;
};

export type RankedModel = SmartModelCandidate & {
  score: number;
  reasons: string[];
};

export type SmartModelRouterOptions = {
  policy: ModelRoutingPolicy;
  task: ModelTask;
  now?: number;
  minimumScore?: number;
  allowPaidFallback?: boolean;
};

const DEFAULT_MINIMUM_SCORE = 0;

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function normalizedLatency(latencyMs: number | undefined): number {
  if (!latencyMs || latencyMs <= 0) return 0.5;
  return 1 / (1 + latencyMs / 1000);
}

function isCoolingDown(candidate: SmartModelCandidate, now: number): boolean {
  return typeof candidate.cooldownUntil === "number" && candidate.cooldownUntil > now;
}

/**
 * Rank candidates without making network calls or guessing provider metadata.
 */
export function rankSmartModels(
  candidates: SmartModelCandidate[],
  options: SmartModelRouterOptions,
): RankedModel[] {
  const now = options.now ?? Date.now();
  const eligible = candidates.filter((candidate) => {
    if (!candidate.available || isCoolingDown(candidate, now)) return false;
    if (options.policy === "free-only" && !candidate.free) return false;
    return true;
  });

  const ranked = eligible.map((candidate): RankedModel => {
    const capability = clamp(candidate.capabilities[options.task] ?? 0);
    const reliability = clamp(candidate.successRate ?? 0.5);
    const latency = normalizedLatency(candidate.latencyMs);
    const contextBonus =
      options.task === "long-context"
        ? clamp((candidate.contextWindow ?? 0) / 200_000)
        : 0;
    const freeBonus = candidate.free ? 1 : 0;
    const toolBonus =
      options.task === "tool-use" || options.task === "browser"
        ? candidate.supportsTools
          ? 1
          : 0
        : 0;
    const visionBonus = options.task === "vision" && candidate.supportsVision ? 1 : 0;

    const score =
      capability * 0.5 +
      reliability * 0.2 +
      latency * 0.1 +
      contextBonus * 0.05 +
      toolBonus * 0.1 +
      visionBonus * 0.1 +
      (options.policy === "free-first" ? freeBonus * 0.15 : 0);

    const reasons: string[] = [];
    if (capability > 0) reasons.push("strong task capability");
    if (candidate.free) reasons.push("free model");
    if (reliability >= 0.8) reasons.push("high recent reliability");
    if (latency >= 0.6) reasons.push("low recent latency");
    if (toolBonus > 0) reasons.push("tool capable");
    if (visionBonus > 0) reasons.push("vision capable");
    if (contextBonus > 0) reasons.push("large context window");

    return { ...candidate, score, reasons };
  });

  return ranked
    .filter((candidate) => candidate.score >= (options.minimumScore ?? DEFAULT_MINIMUM_SCORE))
    .sort((a, b) => b.score - a.score || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
}

/**
 * Select the best eligible candidate. In free-first mode a paid model is only
 * eligible when the caller explicitly enables paid fallback.
 */
export function selectSmartModel(
  candidates: SmartModelCandidate[],
  options: SmartModelRouterOptions,
): RankedModel | undefined {
  const ranked = rankSmartModels(candidates, options);
  if (ranked.length === 0) return undefined;

  if (options.policy === "free-first" && !options.allowPaidFallback) {
    return ranked.find((candidate) => candidate.free);
  }

  return ranked[0];
}

export function classifyModelFailure(status: number | undefined, message = ""): ModelFailureReason {
  const text = message.toLowerCase();
  if (status === 401 || /invalid.*key|unauthorized|authentication/.test(text)) return "authentication";
  if (status === 403 || /forbidden|permission denied/.test(text)) return "permission";
  if (status === 408 || /timeout|timed out/.test(text)) return "timeout";
  if (status === 429 || /rate.?limit|too many requests/.test(text)) return "rate-limit";
  if (/quota|credits?.*(?:exhausted|depleted)|usage limit/.test(text)) return "quota";
  if (/context length|maximum context|too many tokens/.test(text)) return "context-length";
  if (/tool.*(?:not supported|unsupported)|function calling.*unsupported/.test(text)) return "tool-incompatible";
  if (typeof status === "number" && status >= 500) return "provider-error";
  return "unknown";
}

/**
 * Convert a failure into a temporary cooldown. Authentication and permission
 * failures are intentionally not treated as transient.
 */
export function failureCooldownMs(reason: ModelFailureReason): number {
  switch (reason) {
    case "rate-limit":
      return 60_000;
    case "quota":
      return 15 * 60_000;
    case "timeout":
      return 15_000;
    case "provider-error":
      return 30_000;
    case "context-length":
    case "tool-incompatible":
    case "authentication":
    case "permission":
      return 0;
    default:
      return 10_000;
  }
}
