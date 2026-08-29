import {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  type Model,
  type SimpleStreamOptions,
} from "@openclaw/llm-core";
import type { ThinkingLevel } from "./types.js";

export function resolveAgentReasoningOption(
  model: Model,
  thinkingLevel: ThinkingLevel,
): SimpleStreamOptions["reasoning"] {
  if (thinkingLevel !== "off") {
    return thinkingLevel;
  }
  const offFallback =
    model.thinkingLevelMap?.off ??
    ((model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
    resolveClaudeFable5ModelIdentity(model)
      ? "low"
      : undefined);
  switch (offFallback) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return offFallback;
    default:
      // Unsupported off keeps transport defaults; native Sonnet/Opus retain their off contract.
      return model.thinkingLevelMap?.off !== null ||
        (model.api === "anthropic-messages" &&
          (resolveClaudeSonnet5ModelIdentity(model) || resolveClaudeOpus5ModelIdentity(model)))
        ? "off"
        : undefined;
  }
}
