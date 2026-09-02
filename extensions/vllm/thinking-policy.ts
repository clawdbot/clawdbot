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
  return /\bnemotron-3(?:[-_](?:nano|super|ultra))?\b/i.test(modelId);
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | null {
  if (normalizeProviderId(ctx.provider) !== "vllm") {
    return null;
  }
  if (ctx.reasoning === false) {
    return null;
  }
  const qwenFormat = resolveVllmQwenThinkingFormatFromCompat(ctx.compat);
  if (qwenFormat || (ctx.reasoning === true && isVllmNemotronThinkingModel(ctx.modelId))) {
    return VLLM_BINARY_THINKING_PROFILE;
  }
  return null;
}
