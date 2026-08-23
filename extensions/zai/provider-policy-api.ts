// Z.AI public policy surface shared by cold selection and the provider runtime.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function isGlm52ModelId(modelId?: string | null): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).startsWith("glm-5.2");
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  if (isGlm52ModelId(ctx.modelId)) {
    return {
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "off",
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
