import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const BASE_CLAUDE_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
] as const satisfies ProviderThinkingProfile["levels"];

export function isOpus47BedrockModelRef(modelRef: string): boolean {
  return /(?:^|[/.:])(?:(?:us|eu|ap|apac|au|jp|global)\.)?anthropic\.claude-opus-4[.-]7(?:$|[-.:/])/i.test(
    modelRef,
  );
}

export function resolveBedrockClaudeThinkingProfile(modelId: string): ProviderThinkingProfile {
  const trimmed = modelId.trim();
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
