import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  allowsPluginModelNormalization,
  findConfiguredModelProvider,
} from "../configured-provider-model.js";
import { normalizeConfiguredProviderCatalogModelId } from "../model-ref-shared.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  buildModelAliasIndex,
  normalizeModelRef,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../model-selection.js";

export function normalizeAgentCommandModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  return normalizeModelRef(provider, model, {
    ...modelManifestContext,
    allowPluginNormalization: allowsPluginModelNormalization({ cfg, provider, model }),
  });
}

export function normalizeAgentCommandDefaultModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const normalizedProvider = normalizeProviderId(provider);
  if (findConfiguredModelProvider(cfg, normalizedProvider)) {
    return {
      provider: normalizedProvider,
      model: normalizeConfiguredProviderCatalogModelId(normalizedProvider, model, {
        manifestPlugins: modelManifestContext.manifestPlugins,
      }),
    };
  }
  return normalizeAgentCommandModelRef(cfg, provider, model, modelManifestContext);
}

export function parseAgentCommandModelRef(
  cfg: OpenClawConfig,
  agentId: string,
  raw: string,
  defaultProvider: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const parsed = resolveModelRefFromString({
    cfg,
    agentId,
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg,
      agentId,
      defaultProvider,
      ...modelManifestContext,
      allowPluginNormalization: false,
    }),
    ...modelManifestContext,
    allowPluginNormalization: false,
  })?.ref;
  return parsed
    ? normalizeAgentCommandModelRef(cfg, parsed.provider, parsed.model, modelManifestContext)
    : null;
}
