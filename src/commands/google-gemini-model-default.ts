import type { MoltbotConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";

export const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3-pro-preview";

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyGoogleGeminiModelDefault(cfg: MoltbotConfig): {
  next: MoltbotConfig;
  changed: boolean;
} {
  const current = resolvePrimaryModel(cfg.agents?.defaults?.model)?.trim();
  if (current === GOOGLE_GEMINI_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }

  return {
    next: {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model:
            cfg.agents?.defaults?.model && typeof cfg.agents.defaults.model === "object"
              ? {
                  ...cfg.agents.defaults.model,
                  primary: GOOGLE_GEMINI_DEFAULT_MODEL,
                }
              : { primary: GOOGLE_GEMINI_DEFAULT_MODEL },
        },
      },
    },
    changed: true,
  };
}
