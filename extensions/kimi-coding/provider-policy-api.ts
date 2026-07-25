// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

export const KIMI_K3_MODEL_IDS = ["k3", "k3[1m]"] as const;

export function isKimiK3ModelId(modelId: string): boolean {
  return KIMI_K3_MODEL_IDS.includes(
    modelId.trim().toLowerCase() as (typeof KIMI_K3_MODEL_IDS)[number],
  );
}

export function resolveThinkingProfile({
  modelId,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  if (isKimiK3ModelId(modelId)) {
    return {
      levels: [
        { id: "off", label: "off" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  return {
    levels: [
      { id: "off", label: "off" },
      { id: "low", label: "on" },
    ],
    defaultLevel: "off",
  };
}
