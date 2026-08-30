/**
 * Model selection resolution facade.
 *
 * This module resolves configured fallbacks and explicit model selections.
 */
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelRef } from "./model-ref-shared.js";
import {
  buildModelAliasIndexCore as buildModelAliasIndex,
  createModelManifestPluginContext,
  getModelRefStatus,
  resolveAllowedModelRefFromAliasIndex,
  type ModelSelectionNormalizationContext,
} from "./model-selection-shared.js";

export {
  buildModelAliasIndexCore as buildModelAliasIndex,
  getModelRefStatus,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelAliasFromPair,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

/** Resolve agent-owned fallback overrides without loading the full selection facade. */
export function resolveConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  if (params.agentId) {
    const override = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
}

/** Resolves a raw model string into an allowed model ref or an explanatory error. */
export function resolveAllowedModelRefCore(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelSelectionNormalizationContext,
):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  // Candidate refs and their allowlist must use the same static policy; runtime
  // hooks normalize the selected ref later, inside its acquired generation.
  const policyParams = { ...params, allowPluginNormalization: false };
  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(policyParams);
  const aliasIndex = buildModelAliasIndex({
    ...policyParams,
    manifestPluginContext,
  });
  return resolveAllowedModelRefFromAliasIndex({
    ...policyParams,
    manifestPluginContext,
    aliasIndex,
    getStatus: (ref) =>
      getModelRefStatus({
        ...policyParams,
        manifestPluginContext,
        ref,
      }),
  });
}
