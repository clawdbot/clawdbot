// OpenCode Go policy module exposes thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveEffortThinkingProfile } from "openclaw/plugin-sdk/provider-thinking-runtime";

const KIMI_K2_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;
const BINARY_REASONING_PROFILE = {
  levels: [{ id: "off" }, { id: "high", label: "on" }],
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;
const FIXED_REASONING_PROFILE = {
  levels: [{ id: "off", label: "always on" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;
const FIXED_ANTHROPIC_REASONING_PROFILE = {
  levels: [{ id: "high", label: "always on" }],
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;
const KIMI_K2_MODEL_IDS = new Set(["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"]);
const FIXED_ANTHROPIC_REASONING_MODEL_IDS = new Set(["minimax-m2.5", "minimax-m2.7"]);
const BINARY_REASONING_MODEL_IDS = new Set(["minimax-m3"]);

export function isOpencodeGoFixedAnthropicReasoningModelId(modelId: unknown): boolean {
  return (
    typeof modelId === "string" &&
    FIXED_ANTHROPIC_REASONING_MODEL_IDS.has(modelId.trim().toLowerCase())
  );
}

export function resolveOpencodeGoThinkingProfile(
  modelId: string,
  context?: Pick<ProviderDefaultThinkingPolicyContext, "api" | "reasoning" | "compat">,
): ProviderThinkingProfile | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === "deepseek-v4-flash") {
    return {
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
      defaultLevel: "high",
    };
  }
  if (normalized === "deepseek-v4-pro") {
    return {
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "high",
    };
  }
  if (normalized === "kimi-k3") {
    return { levels: [{ id: "off" }, { id: "max" }], defaultLevel: "off" };
  }
  if (KIMI_K2_MODEL_IDS.has(normalized)) {
    return KIMI_K2_THINKING_PROFILE;
  }
  const effortProfile = resolveEffortThinkingProfile(context?.compat?.supportedReasoningEfforts);
  if (effortProfile) {
    return effortProfile;
  }
  if (BINARY_REASONING_MODEL_IDS.has(normalized)) {
    return BINARY_REASONING_PROFILE;
  }
  if (FIXED_ANTHROPIC_REASONING_MODEL_IDS.has(normalized)) {
    return FIXED_ANTHROPIC_REASONING_PROFILE;
  }
  if (context?.reasoning === true && context.api === "openai-completions") {
    return FIXED_REASONING_PROFILE;
  }
  return undefined;
}

export function resolveThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  return context.provider.trim().toLowerCase() === "opencode-go"
    ? resolveOpencodeGoThinkingProfile(context.modelId, context)
    : undefined;
}
