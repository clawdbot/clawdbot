// Moonshot policy module exposes model-specific thinking controls before runtime registration.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import { isNativeMoonshotBaseUrl } from "./provider-catalog.js";

export const KIMI_K2_7_CODE_MODEL_ID = "kimi-k2.7-code";
export const KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID = "kimi-k2.7-code-highspeed";
export const KIMI_K3_MODEL_ID = "kimi-k3";
const ALWAYS_THINKING_PROFILES = {
  [KIMI_K3_MODEL_ID]: { id: "max", label: "max" },
  [KIMI_K2_7_CODE_MODEL_ID]: { id: "low", label: "on" },
  [KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID]: { id: "low", label: "on" },
} as const;

export function isMoonshotK3NativeVideoRoute(route: {
  provider?: string;
  modelId?: string;
  api?: string;
  baseUrl?: string;
}): boolean {
  return (
    route.provider === "moonshot" &&
    route.modelId === KIMI_K3_MODEL_ID &&
    route.api === "openai-completions" &&
    isNativeMoonshotBaseUrl(route.baseUrl)
  );
}

export function isMoonshotAlwaysThinkingModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase() in ALWAYS_THINKING_PROFILES;
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  const modelId = context.modelId.trim().toLowerCase();
  const profile = ALWAYS_THINKING_PROFILES[modelId as keyof typeof ALWAYS_THINKING_PROFILES];
  if (profile) {
    return {
      levels: [profile],
      defaultLevel: profile.id,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  return {
    levels: [
      { id: "off" as const, label: "off" },
      { id: "low" as const, label: "on" },
    ],
    defaultLevel: "off" as const,
  };
}
