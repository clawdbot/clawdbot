// Reasoning effort utilities map provider thinking controls to runtime levels.
import type { ThinkLevel } from "../../../auto-reply/thinking.js";

/** Reasoning effort values accepted by OpenAI-compatible providers. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Maps OpenClaw thinking levels onto provider reasoning-effort labels. */
export function mapThinkingLevelToReasoningEffort(thinkingLevel: ThinkLevel): ReasoningEffort {
  if (thinkingLevel === "off") {
    return "none";
  }
  if (thinkingLevel === "adaptive") {
    return "medium";
  }
  if (thinkingLevel === "max") {
    return "xhigh";
  }
  return thinkingLevel;
}
