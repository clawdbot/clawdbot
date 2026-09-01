// Fal setup module handles plugin onboarding behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";

const FAL_DEFAULT_IMAGE_MODEL_REF = "fal/fal-ai/flux/dev";

export function applyFalConfig(cfg: OpenClawConfig): OpenClawConfig {
  if (cfg.agents?.defaults?.mediaModels?.image) {
    return cfg;
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        mediaModels: {
          ...cfg.agents?.defaults?.mediaModels,
          image: { primary: FAL_DEFAULT_IMAGE_MODEL_REF },
        },
      },
    },
  };
}
