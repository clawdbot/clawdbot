/**
 * Builds model visibility policies while retaining configured automatic fallbacks.
 */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig, resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  createModelVisibilityPolicyWithFallbacks,
  type ModelVisibilityPolicy,
} from "./model-selection-shared.js";

export const RUNTIME_MODEL_VISIBILITY_NORMALIZATION = {
  allowManifestNormalization: true,
  allowPluginNormalization: true,
} as const;

function resolveAllowedFallbacks(params: { cfg: OpenClawConfig; agentId?: string }): string[] {
  if (params.agentId) {
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

function resolveAdditionalConfiguredModelRefs(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  const defaults = params.cfg.agents?.defaults;
  const agent = params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  return [
    resolveAgentModelPrimaryValue(defaults?.model),
    ...resolveAgentModelFallbackValues(defaults?.model),
    resolveAgentModelPrimaryValue(agent?.model),
    ...resolveAgentModelFallbackValues(agent?.model),
    ...Object.keys(defaults?.models ?? {}),
    ...Object.keys(agent?.models ?? {}),
    agent?.utilityModel ?? defaults?.utilityModel,
    resolveAgentModelPrimaryValue(defaults?.imageModel),
    ...resolveAgentModelFallbackValues(defaults?.imageModel),
    resolveAgentModelPrimaryValue(defaults?.pdfModel),
    ...resolveAgentModelFallbackValues(defaults?.pdfModel),
  ].filter((ref): ref is string => typeof ref === "string");
}

export function createModelVisibilityPolicy(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelVisibilityPolicy {
  return createModelVisibilityPolicyWithFallbacks({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    fallbackModels: resolveAllowedFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
    additionalConfiguredModelRefs: resolveAdditionalConfiguredModelRefs(params),
    // Model visibility is used by lightweight status/list paths. Keep plugin
    // manifest normalization opt-in so those paths do not load plugin runtime
    // metadata unless a caller explicitly needs it.
    allowManifestNormalization: params.allowManifestNormalization ?? false,
    allowPluginNormalization: params.allowPluginNormalization ?? false,
    manifestPlugins: params.manifestPlugins,
  });
}

export type { ModelVisibilityPolicy };
