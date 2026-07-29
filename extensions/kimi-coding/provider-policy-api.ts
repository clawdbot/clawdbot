// Kimi Code policy module exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

export const KIMI_K3_MODEL_IDS = ["k3", "k3-256k"] as const;
const KIMI_K3_LEGACY_MODEL_IDS = ["k3[1m]"] as const;

const KIMI_K3_THINKING_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "adaptive" },
  { id: "xhigh" },
  { id: "max" },
] as const satisfies ProviderThinkingProfile["levels"];

export function isKimiK3ModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    KIMI_K3_MODEL_IDS.includes(normalized as (typeof KIMI_K3_MODEL_IDS)[number]) ||
    KIMI_K3_LEGACY_MODEL_IDS.includes(normalized as (typeof KIMI_K3_LEGACY_MODEL_IDS)[number])
  );
}

export function resolveThinkingProfile({
  modelId,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile {
  if (isKimiK3ModelId(modelId)) {
    return {
      levels: KIMI_K3_THINKING_LEVELS,
      defaultLevel: "high",
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
