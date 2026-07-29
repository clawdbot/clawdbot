/**
 * Small shared normalization helpers for embedded-agent runner settings.
 */
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { ThinkingLevel } from "../runtime/index.js";

export type ProviderThinkLevel = Exclude<ThinkLevel, "ultra">;

export function normalizeContextTokenBudget(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Converts logical product modes into provider-facing effort values. */
export function mapThinkingLevelForProvider(level?: ThinkLevel): ProviderThinkLevel | undefined {
  return level === "ultra" ? "max" : level;
}

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // agent runtime supports elevated levels; OpenClaw enables them for specific models.
  const providerLevel = mapThinkingLevelForProvider(level);
  if (!providerLevel) {
    return "off";
  }
  // Runtime streams do not expose a distinct adaptive level. Preserve the
  // provider-owned adaptive default by using Claude's documented high effort.
  if (providerLevel === "adaptive") {
    return "high";
  }
  return providerLevel;
}

export type { ReasoningLevel, ThinkLevel };
