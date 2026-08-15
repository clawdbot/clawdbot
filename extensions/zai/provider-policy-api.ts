// Z.AI public policy surface shared by cold selection and the provider runtime.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type ZaiReasoningEffort = "low" | "high" | "max";
type ZaiThinkingLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;

const ZAI_REASONING_EFFORT_MAPS: Record<
  "5.2" | "5.3",
  Partial<Record<ZaiThinkingLevel, ZaiReasoningEffort>>
> = {
  "5.2": { low: "high", medium: "high", high: "high", adaptive: "high", xhigh: "max", max: "max" },
  "5.3": {
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
    xhigh: "max",
    adaptive: "max",
    max: "max",
  },
};

function resolveGlmReasoningEffortVersion(modelId?: string | null): "5.2" | "5.3" | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (normalized.startsWith("glm-5.3")) {
    return "5.3";
  }
  return normalized.startsWith("glm-5.2") ? "5.2" : undefined;
}

export function resolveZaiReasoningEffort(
  modelId: string,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ZaiReasoningEffort | undefined {
  const version = resolveGlmReasoningEffortVersion(modelId);
  return version && thinkingLevel ? ZAI_REASONING_EFFORT_MAPS[version][thinkingLevel] : undefined;
}

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const version = resolveGlmReasoningEffortVersion(ctx.modelId);
  if (version === "5.3") {
    return {
      levels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
    };
  }
  if (version === "5.2") {
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
