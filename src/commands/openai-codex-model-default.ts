import type { ClawdbotConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";

export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.2";

function shouldSetOpenAICodexModel(model?: string): boolean {
  const trimmed = model?.trim();
  if (!trimmed) return true;
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("openai-codex/")) return false;
  if (normalized.startsWith("openai/")) return true;
  return normalized === "gpt" || normalized === "gpt-mini";
}

function resolvePrimaryModel(
  model?: AgentModelListConfig | string,
): string | undefined {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyOpenAICodexModelDefault(cfg: ClawdbotConfig): {
  next: ClawdbotConfig;
  changed: boolean;
} {
  const current = resolvePrimaryModel(cfg.agent?.model);
  if (!shouldSetOpenAICodexModel(current)) {
    return { next: cfg, changed: false };
  }
  return {
    next: {
      ...cfg,
      agent: {
        ...cfg.agent,
        model:
          cfg.agent?.model && typeof cfg.agent.model === "object"
            ? { ...cfg.agent.model, primary: OPENAI_CODEX_DEFAULT_MODEL }
            : { primary: OPENAI_CODEX_DEFAULT_MODEL },
      },
    },
    changed: true,
  };
}
