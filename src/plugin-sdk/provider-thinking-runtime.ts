import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";
export {
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
} from "@openclaw/ai/internal/google-model-family";

const THINKING_LEVEL_IDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Provider policies load eagerly; keep this module free of streaming runtime imports.
export function resolveEffortThinkingProfile(
  efforts: readonly string[] | null | undefined,
): ProviderThinkingProfile | undefined {
  if (!efforts || efforts.length === 0) {
    return undefined;
  }
  const acceptedLevelIds = ["off", ...efforts.map((effort) => (effort === "none" ? "off" : effort))]
    .filter((id): id is ProviderThinkingProfile["levels"][number]["id"] =>
      THINKING_LEVEL_IDS.has(id),
    )
    .filter((id, index, values) => values.indexOf(id) === index);
  const levels = acceptedLevelIds.map((id) => ({ id }));
  const defaultLevel = acceptedLevelIds.includes("medium")
    ? "medium"
    : acceptedLevelIds.includes("high")
      ? "high"
      : acceptedLevelIds.includes("low")
        ? "low"
        : "off";
  return { levels, defaultLevel };
}
