// Provides model selection, usage, and thinking-level utility helpers.
import {
  resolveClaudeNativeThinkingLevelMap,
  requiresClaudeMandatoryAdaptiveThinking,
} from "@openclaw/llm-core";
import type { Api, Model, ModelCostTier, ModelThinkingLevel, Usage } from "./types.js";

function selectCostTier(
  tiers: ModelCostTier[] | undefined,
  inputTokens: number,
): ModelCostTier | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const sorted = tiers.toSorted((a, b) => a.range[0] - b.range[0]);
  if (inputTokens <= 0) {
    return sorted[0];
  }
  const tier = sorted.find((candidate) => {
    const [start, end] = candidate.range;
    return inputTokens >= start && (end === undefined || inputTokens < end);
  });
  if (tier) {
    return tier;
  }
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const candidate = sorted[index];
    if (candidate && inputTokens >= candidate.range[0]) {
      return candidate;
    }
  }
  return sorted[0];
}

function calculateSampleCost(
  model: Model,
  sample: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
  },
): Usage["cost"] {
  const tier = selectCostTier(model.cost.tieredPricing, sample.input);
  const rates = tier ?? model.cost;
  const cacheWrite1h = Math.min(sample.cacheWrite, Math.max(0, sample.cacheWrite1h ?? 0));
  const cacheWrite5m = sample.cacheWrite - cacheWrite1h;
  return {
    input: (rates.input / 1_000_000) * sample.input,
    output: (rates.output / 1_000_000) * sample.output,
    cacheRead: (rates.cacheRead / 1_000_000) * sample.cacheRead,
    cacheWrite: (rates.cacheWrite * cacheWrite5m + rates.input * 2 * cacheWrite1h) / 1_000_000,
    total: 0,
  };
}

/** Calculates and stores model cost fields from token usage and per-million pricing. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  const samples = usage.costByIteration;
  if (samples && samples.length > 0) {
    const total = samples.reduce(
      (acc, sample) => {
        const cost = calculateSampleCost(model, sample);
        acc.input += cost.input;
        acc.output += cost.output;
        acc.cacheRead += cost.cacheRead;
        acc.cacheWrite += cost.cacheWrite;
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    );
    total.total = total.input + total.output + total.cacheRead + total.cacheWrite;
    Object.assign(usage.cost, total);
    // Per-iteration samples are an internal billing aid; do not let them
    // escape through usage objects that may be forwarded or persisted.
    usage.costByIteration = undefined;
    return usage.cost;
  }
  const cost = calculateSampleCost(model, usage);
  Object.assign(usage.cost, cost);
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

/** Replaces the catalog estimate when the provider reports an authoritative billed total. */
export function applyProviderReportedUsageCost(usage: Usage, reportedCost: unknown): void {
  if (typeof reportedCost !== "number" || !Number.isFinite(reportedCost) || reportedCost < 0) {
    return;
  }
  usage.cost.total = reportedCost;
  usage.cost.totalOrigin = "provider-billed";
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function resolveThinkingLevelMap<TApi extends Api>(model: Model<TApi>) {
  return model.api === "anthropic-messages"
    ? (resolveClaudeNativeThinkingLevelMap(model) ?? model.thinkingLevelMap)
    : model.thinkingLevelMap;
}

/** Returns thinking levels exposed by a reasoning-capable model. */
export function getSupportedThinkingLevels<TApi extends Api>(
  model: Model<TApi>,
): ModelThinkingLevel[] {
  const mandatoryAdaptiveContract =
    model.api === "anthropic-messages" && requiresClaudeMandatoryAdaptiveThinking(model);
  if (!model.reasoning && !mandatoryAdaptiveContract) {
    return ["off"];
  }
  const thinkingLevelMap = resolveThinkingLevelMap(model);

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

/** Clamps a requested thinking level to the closest supported level for a model. */
export function clampThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: ModelThinkingLevel,
): ModelThinkingLevel {
  const availableLevels = getSupportedThinkingLevels(model);
  if (availableLevels.includes(level)) {
    return level;
  }

  const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  // Explicit provider opt-outs are hard caps. Downgrade them before considering
  // stronger levels so unsupported xhigh/max requests cannot increase cost.
  const thinkingLevelMap = resolveThinkingLevelMap(model);
  if ((level === "xhigh" || level === "max") && thinkingLevelMap?.[level] === null) {
    for (const candidate of EXTENDED_THINKING_LEVELS.slice(0, requestedIndex).toReversed()) {
      if (availableLevels.includes(candidate)) {
        return candidate;
      }
    }
  }

  // Prefer the next stronger available level, then walk down if the request was above the model cap.
  for (const candidate of EXTENDED_THINKING_LEVELS.slice(requestedIndex)) {
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  for (const candidate of EXTENDED_THINKING_LEVELS.slice(0, requestedIndex).toReversed()) {
    if (availableLevels.includes(candidate)) {
      return candidate;
    }
  }
  return availableLevels[0] ?? "off";
}

/** Compares model identity by provider and id. */
export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.id === b.id && a.provider === b.provider;
}
