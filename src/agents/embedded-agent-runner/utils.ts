import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { ThinkingLevel } from "../runtime/index.js";

export function normalizeContextTokenBudget(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // agent runtime supports "xhigh"; OpenClaw enables it for specific models.
  if (!level) {
    return "off";
  }
  if (level === "max") {
    return "xhigh";
  }
  // "adaptive" maps to "medium" at the agent runtime layer.  The provider adapter
  // provider then translates this to `thinking.type: "adaptive"` with
  // `output_config.effort: "medium"` for models that support it (Opus 4.6,
  // Sonnet 4.6).
  if (level === "adaptive") {
    return "medium";
  }
  return level;
}

export type { ReasoningLevel, ThinkLevel };
