import type { AgentModelListConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyAgentDefaultPrimaryModel(params: {
  cfg: OpenClawConfig;
  model: string;
  legacyModels?: Set<string>;
}): { next: OpenClawConfig; changed: boolean } {
  const current = resolvePrimaryModel(params.cfg.agents?.defaults?.model)?.trim();
  const normalizedCurrent = current && params.legacyModels?.has(current) ? params.model : current;
  if (normalizedCurrent === params.model) {
    return { next: params.cfg, changed: false };
  }

  return {
    next: {
      ...params.cfg,
      agents: {
        ...params.cfg.agents,
        defaults: {
          ...params.cfg.agents?.defaults,
          model:
            params.cfg.agents?.defaults?.model &&
            typeof params.cfg.agents.defaults.model === "object"
              ? {
                  ...params.cfg.agents.defaults.model,
                  primary: params.model,
                }
              : { primary: params.model },
        },
      },
    },
    changed: true,
  };
}

export function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = defaults?.models;
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: model,
        },
        models: {
          ...existingModels,
          [model]: existingModels?.[model] ?? {},
        },
      },
    },
  };
}
