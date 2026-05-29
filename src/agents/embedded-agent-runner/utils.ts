import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { ThinkingLevel } from "../runtime/index.js";

export function normalizeContextTokenBudget(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // agent runtime supports elevated levels; OpenClaw enables them for specific models.
  if (!level) {
    return "off";
  }
  // Runtime streams do not expose a distinct adaptive level. Preserve the
  // provider-owned adaptive default by using Claude's documented high effort.
  if (level === "adaptive") {
    return "high";
  }
  return level;
}

export type { ReasoningLevel, ThinkLevel };
