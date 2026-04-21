import type { ThinkLevel } from "../../auto-reply/thinking.js";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
