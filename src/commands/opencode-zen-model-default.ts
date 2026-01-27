import type { MoltbotConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";

export const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-5";
const LEGACY_OPENCODE_ZEN_DEFAULT_MODEL = "opencode-zen/claude-opus-4-5";

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyOpencodeZenModelDefault(cfg: MoltbotConfig): {
  next: MoltbotConfig;
  changed: boolean;
} {
  const current = resolvePrimaryModel(cfg.agents?.defaults?.model)?.trim();
  const normalizedCurrent =
    current === LEGACY_OPENCODE_ZEN_DEFAULT_MODEL ? OPENCODE_ZEN_DEFAULT_MODEL : current;
  if (normalizedCurrent === OPENCODE_ZEN_DEFAULT_MODEL) {
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
                  primary: OPENCODE_ZEN_DEFAULT_MODEL,
                }
              : { primary: OPENCODE_ZEN_DEFAULT_MODEL },
        },
      },
    },
    changed: true,
  };
}
