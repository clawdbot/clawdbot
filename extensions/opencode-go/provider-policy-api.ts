// OpenCode Go policy module exposes thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

const OPENCODE_GO_DEEPSEEK_V4_MODEL_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
const OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_IDS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const OPENCODE_GO_DEEPSEEK_V4_THINKING_PROFILE = {
  levels: OPENCODE_GO_DEEPSEEK_V4_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function isOpencodeGoDeepSeekV4ModelId(modelId: unknown): boolean {
  return (
    typeof modelId === "string" &&
    OPENCODE_GO_DEEPSEEK_V4_MODEL_IDS.has(modelId.trim().toLowerCase())
  );
}

export function resolveOpencodeGoThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isOpencodeGoDeepSeekV4ModelId(modelId)
    ? OPENCODE_GO_DEEPSEEK_V4_THINKING_PROFILE
    : undefined;
}

export function resolveThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  return context.provider.trim().toLowerCase() === "opencode-go"
    ? resolveOpencodeGoThinkingProfile(context.modelId)
    : undefined;
}
