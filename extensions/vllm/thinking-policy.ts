// Vllm plugin module implements thinking policy behavior.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

export type VllmQwenThinkingFormat = "chat-template" | "top-level";

const VLLM_BINARY_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
} satisfies ProviderThinkingProfile;

// Self-hosted discovery's reasoning heuristic doesn't match aliases like
// "yk_nemotron-3-super", so discovered models land with reasoning: false.
// Nemotron 3's chat-template contract is fixed for the family, so trust the
// id match over that generic catalog hint.
const VLLM_NEMOTRON_THINKING_PROFILE = {
  ...VLLM_BINARY_THINKING_PROFILE,
  preserveWhenCatalogReasoningFalse: true,
} satisfies ProviderThinkingProfile;

// Same rationale as VLLM_NEMOTRON_THINKING_PROFILE, for DeepSeek V4 aliases.
const VLLM_DEEPSEEK_V4_THINKING_PROFILE = {
  levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
  defaultLevel: "off",
  preserveWhenCatalogReasoningFalse: true,
} satisfies ProviderThinkingProfile;

function normalizeVllmQwenThinkingFormat(value: unknown): VllmQwenThinkingFormat | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "chat-template" ||
    normalized === "chat-template-kwargs" ||
    normalized === "chat-template-kwarg" ||
    normalized === "chat-template-arguments" ||
    normalized === "qwen-chat-template"
  ) {
    return "chat-template";
  }
  if (
    normalized === "top-level" ||
    normalized === "enable-thinking" ||
    normalized === "request-body" ||
    normalized === "qwen"
  ) {
    return "top-level";
  }
  return undefined;
}

export function resolveVllmQwenThinkingFormatFromCompat(
  compat?: ProviderDefaultThinkingPolicyContext["compat"],
): VllmQwenThinkingFormat | undefined {
  return normalizeVllmQwenThinkingFormat(compat?.thinkingFormat);
}

function isVllmNemotronThinkingModel(modelId: string): boolean {
  return /nemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(modelId);
}

export function isVllmDeepSeekV4ThinkingModel(modelId: string): boolean {
  return /deepseek[-_]?v4(?:[-_](?:pro|flash))?\b/i.test(modelId);
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | null {
  if (normalizeProviderId(ctx.provider) !== "vllm") {
    return null;
  }
  // Known-model-family id matches run before the reasoning gate below so
  // discovered aliases with a stale `reasoning: false` still expose /think.
  if (isVllmNemotronThinkingModel(ctx.modelId)) {
    return VLLM_NEMOTRON_THINKING_PROFILE;
  }
  if (isVllmDeepSeekV4ThinkingModel(ctx.modelId)) {
    return VLLM_DEEPSEEK_V4_THINKING_PROFILE;
  }
  if (ctx.reasoning === false) {
    return null;
  }
  const qwenFormat = resolveVllmQwenThinkingFormatFromCompat(ctx.compat);
  if (qwenFormat) {
    return VLLM_BINARY_THINKING_PROFILE;
  }
  return null;
}
