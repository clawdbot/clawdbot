// Resolves primary model metadata for plugin-owned providers.
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Applies a primary model to agent defaults while preserving model fallback metadata. */
export function applyPrimaryModel(cfg: OpenClawConfig, model: string): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks?.map((fallback) =>
          normalizeAgentModelRefForConfig(fallback),
        )
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: normalizedModel,
        },
        models: {
          ...existingModels,
          [normalizedModel]: existingModels?.[normalizedModel] ?? {},
        },
      },
    },
  };
}
