/**
 * Model selection resolution facade.
 *
 * This module exposes model-selection helpers that need default fallback model
 * handling before checking aliases, allowlists, catalogs, and plugin manifests.
 */
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelFallbacksOverride } from "./agent-scope.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-selection-normalize.js";
import {
  buildModelAliasIndex,
  getModelRefStatusWithFallbackModels,
  resolveAllowedModelRefFromAliasIndex,
  type ModelRefStatus,
} from "./model-selection-shared.js";

export {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

function resolveDefaultFallbackModels(cfg: OpenClawConfig, agentId?: string): string[] {
  if (agentId) {
    const override = resolveAgentModelFallbacksOverride(cfg, agentId);
    if (override !== undefined) {
      return override;
    }
  }
  return resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
}

/** Returns whether a normalized model ref is available, allowed, or fallback-backed. */
export function getModelRefStatus(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelManifestNormalizationContext,
): ModelRefStatus {
  const { cfg, catalog, ref, defaultProvider, defaultModel, agentId, manifestPlugins } = params;
  return getModelRefStatusWithFallbackModels({
    cfg,
    catalog,
    ref,
    defaultProvider,
    defaultModel,
    agentId,
    fallbackModels: resolveDefaultFallbackModels(cfg, agentId),
    manifestPlugins,
  });
}

/** Resolves a raw model string into an allowed model ref or an explanatory error. */
export function resolveAllowedModelRef(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
  } & ModelManifestNormalizationContext,
):
  | { ref: ModelRef; key: string }
  | {
      error: string;
    } {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
    agentId: params.agentId,
    manifestPlugins: params.manifestPlugins,
  });
  return resolveAllowedModelRefFromAliasIndex({
    cfg: params.cfg,
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    aliasIndex,
    manifestPlugins: params.manifestPlugins,
    getStatus: (ref) =>
      getModelRefStatus({
        cfg: params.cfg,
        catalog: params.catalog,
        ref,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        agentId: params.agentId,
        manifestPlugins: params.manifestPlugins,
      }),
  });
}
