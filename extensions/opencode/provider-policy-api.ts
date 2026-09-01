import { resolveClaudeThinkingProfile } from "openclaw/plugin-sdk/claude-model-runtime";
// Opencode API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

const FIXED_REASONING_PROFILE = {
  levels: [{ id: "off", label: "always on" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;

const THINKING_LEVEL_IDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function resolveEffortThinkingProfile(
  efforts: readonly string[] | null | undefined,
): ProviderThinkingProfile | undefined {
  if (!efforts || efforts.length === 0) {
    return undefined;
  }
  const acceptedLevelIds = ["off", ...efforts.map((effort) => (effort === "none" ? "off" : effort))]
    .filter((id) => THINKING_LEVEL_IDS.has(id))
    .filter((id, index, values) => values.indexOf(id) === index) as Array<
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >;
  const levels = acceptedLevelIds.map((id) => ({ id }));
  const levelIdSet = new Set(acceptedLevelIds);
  const defaultLevel = levelIdSet.has("medium")
    ? "medium"
    : levelIdSet.has("high")
      ? "high"
      : levelIdSet.has("low")
        ? "low"
        : "off";
  return { levels, defaultLevel };
}

export function resolveThinkingProfile(params: ProviderDefaultThinkingPolicyContext) {
  const modelId = params.modelId.trim().toLowerCase();
  if (modelId.startsWith("claude-")) {
    return resolveClaudeThinkingProfile(modelId);
  }
  const effortProfile = resolveEffortThinkingProfile(params.compat?.supportedReasoningEfforts);
  if (effortProfile) {
    return effortProfile;
  }
  return params.reasoning === true && params.api !== "anthropic-messages"
    ? FIXED_REASONING_PROFILE
    : undefined;
}
