import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  createModelVisibilityPolicyWithFallbacks,
  type ModelVisibilityPolicy,
} from "./model-selection-shared.js";

function resolveAllowedFallbacks(params: { cfg: OpenClawConfig; agentId?: string }): string[] {
  if (params.agentId) {
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

export function createModelVisibilityPolicy(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  defaultProvider: string;
  defaultModel?: string;
  agentId?: string;
}): ModelVisibilityPolicy {
  return createModelVisibilityPolicyWithFallbacks({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    fallbackModels: resolveAllowedFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
  });
}

export type { ModelVisibilityPolicy };
