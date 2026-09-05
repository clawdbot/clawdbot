// Meta plugin module implements thinking behavior.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { META_MODEL_CATALOG } from "./models.js";

const META_REASONING_MODEL_IDS = new Set(
  META_MODEL_CATALOG.filter((model) => model.reasoning).map((model) => model.id.toLowerCase()),
);

const META_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const META_THINKING_PROFILE = {
  levels: META_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveMetaThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  // Some control-plane callers have no runtime catalog. Fall back to the
  // process-stable manifest so those paths retain the same model policy.
  const reasoning =
    context.reasoning ?? META_REASONING_MODEL_IDS.has(context.modelId.toLowerCase());
  return reasoning ? META_THINKING_PROFILE : undefined;
}
