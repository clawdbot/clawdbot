// Test-only bridge that feeds legacy fixture values through the canonical mediaModels owner.
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type MediaCapability = "image" | "music" | "video";
type LegacyMediaModelKey = "imageGenerationModel" | "musicGenerationModel" | "videoGenerationModel";

export function canonicalizeMediaGenerationTestConfig(
  config: OpenClawConfig,
  capability: MediaCapability,
  legacyKey: LegacyMediaModelKey,
): OpenClawConfig {
  const defaults = config.agents?.defaults as
    | (NonNullable<OpenClawConfig["agents"]>["defaults"] & Record<string, unknown>)
    | undefined;
  const legacyValue = defaults?.[legacyKey];
  if (legacyValue === undefined || defaults?.mediaModels?.[capability] !== undefined) {
    return config;
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...defaults,
        mediaModels: { ...defaults?.mediaModels, [capability]: legacyValue },
      },
    },
  };
}
