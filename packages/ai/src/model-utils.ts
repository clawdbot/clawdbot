// Provides model selection, usage, and thinking-level utility helpers.
import {
  resolveClaudeNativeThinkingLevelMap,
  requiresClaudeMandatoryAdaptiveThinking,
} from "@openclaw/llm-core";
import { normalizeOpenAIReasoningEffort } from "./providers/openai-reasoning-effort.js";
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.js";

/** Calculates and stores model cost fields from token usage and per-million pricing. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  const cacheWrite1h = Math.min(usage.cacheWrite, Math.max(0, usage.cacheWrite1h ?? 0));
  const cacheWrite5m = usage.cacheWrite - cacheWrite1h;
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite =
    (model.cost.cacheWrite * cacheWrite5m + model.cost.input * 2 * cacheWrite1h) / 1000000;
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

type OpenAIReasoningCompat = {
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
  reasoningEffortMap?: Record<string, string>;
};

function getCompatReasoningConfig<TApi extends Api>(
  model: Model<TApi>,
): OpenAIReasoningCompat | undefined {
  if (model.api !== "openai-completions" && model.api !== "openai-responses") {
    return undefined;
  }
  const compat = model.compat;
  if (!compat || typeof compat !== "object") {
    return undefined;
  }
  return {
    supportsReasoningEffort:
      "supportsReasoningEffort" in compat ? compat.supportsReasoningEffort : undefined,
    supportedReasoningEfforts:
      "supportedReasoningEfforts" in compat ? compat.supportedReasoningEfforts : undefined,
    reasoningEffortMap: "reasoningEffortMap" in compat ? compat.reasoningEffortMap : undefined,
  };
}

function normalizeReasoningEffort(value: unknown): string {
  return typeof value === "string" ? normalizeOpenAIReasoningEffort(value) : "";
}

function supportsCompatExtendedThinkingLevel<TApi extends Api>(
  model: Model<TApi>,
  level: "xhigh" | "max",
  thinkingLevelMapValue: string | null | undefined,
): boolean {
  const compat = getCompatReasoningConfig(model);
  if (compat?.supportsReasoningEffort === false) {
    return false;
  }

  const supported = new Set(
    (compat?.supportedReasoningEfforts ?? [])
      .map(normalizeReasoningEffort)
      .filter((effort) => effort.length > 0),
  );
  const compatEffortMap = compat?.reasoningEffortMap;
  const hasCompatMapping = compatEffortMap !== undefined && Object.hasOwn(compatEffortMap, level);
  const mappedValue = hasCompatMapping ? compatEffortMap[level] : thinkingLevelMapValue;
  if (mappedValue === null) {
    return false;
  }
  const mapped = normalizeReasoningEffort(mappedValue);

  if (level === "max") {
    if (hasCompatMapping) {
      return supported.size > 0 && Boolean(mapped) && supported.has(mapped);
    }
    return supported.has(level);
  }
  if (hasCompatMapping && !mapped) {
    return false;
  }
  if (mapped) {
    return supported.size === 0 ? !hasCompatMapping : supported.has(mapped);
  }
  return supported.has(level);
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
  const compat = getCompatReasoningConfig(model);
  if (compat?.supportsReasoningEffort === false) {
    return ["off"];
  }
  const thinkingLevelMap = resolveThinkingLevelMap(model);

  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      const compat = getCompatReasoningConfig(model);
      if (compat === undefined) {
        return mapped !== undefined;
      }
      if (compat.supportsReasoningEffort === false) {
        return false;
      }
      return supportsCompatExtendedThinkingLevel(model, level, mapped);
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
