// Moonshot policy module exposes model-specific thinking controls before runtime registration.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";

export const KIMI_K2_7_CODE_MODEL_ID = "kimi-k2.7-code";
export const KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID = "kimi-k2.7-code-highspeed";
export const KIMI_K3_MODEL_ID = "kimi-k3";

export function isMoonshotAlwaysThinkingModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized === KIMI_K2_7_CODE_MODEL_ID ||
    normalized === KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID ||
    normalized === KIMI_K3_MODEL_ID
  );
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  const modelId = context.modelId.trim().toLowerCase();
  if (modelId === KIMI_K3_MODEL_ID) {
    return {
      levels: [{ id: "max" as const, label: "max" }],
      defaultLevel: "max" as const,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (modelId === KIMI_K2_7_CODE_MODEL_ID || modelId === KIMI_K2_7_CODE_HIGHSPEED_MODEL_ID) {
    return {
      levels: [{ id: "low" as const, label: "on" }],
      defaultLevel: "low" as const,
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
