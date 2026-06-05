/**
 * Thinking-level policy for Claude models on Amazon Bedrock. It maps Bedrock
 * model ids to the provider SDK thinking levels that are actually supported.
 */
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

function isOpus48BedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?anthropic\.claude-opus-4[.-]8(?:$|[-.:/])/i.test(
    modelRef,
  );
}

/** Return whether a Bedrock model ref names Claude Opus 4.7. */
export function isOpus47BedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?anthropic\.claude-opus-4[.-]7(?:$|[-.:/])/i.test(
    modelRef,
  );
}

/** Return whether a Bedrock model ref names Claude Opus 4.7 or newer. */
export function isOpus47OrNewerBedrockModelRef(modelRef: string): boolean {
  return isOpus47BedrockModelRef(modelRef) || isOpus48BedrockModelRef(modelRef);
}

/** Resolve supported Claude thinking levels for a Bedrock model id. */
export function resolveBedrockClaudeThinkingProfile(modelId: string): ProviderThinkingProfile {
  const trimmed = modelId.trim();
  if (isOpus48BedrockModelRef(trimmed)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (isOpus47BedrockModelRef(trimmed)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "xhigh" }, { id: "adaptive" }, { id: "max" }],
      defaultLevel: "off",
    };
  }
  if (/claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i.test(trimmed)) {
    return {
      levels: [...BASE_CLAUDE_THINKING_LEVELS, { id: "adaptive" }],
      defaultLevel: "adaptive",
    };
  }
  return { levels: BASE_CLAUDE_THINKING_LEVELS };
}
