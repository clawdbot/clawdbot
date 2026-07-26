import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { normalizeConfiguredProviderCatalogModelId } from "../model-ref-shared.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  buildModelAliasIndex,
  normalizeModelRef,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../model-selection.js";

function hasExactConfiguredProviderModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  if (!normalizedProvider || !model) {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== normalizedProvider) {
      continue;
    }
    return (providerConfig.models ?? []).some((entry) => entry.id.trim() === model);
  }
  return false;
}

function hasConfiguredProvider(params: { cfg: OpenClawConfig; provider: string }): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return false;
  }
  return Object.keys(params.cfg.models?.providers ?? {}).some(
    (providerId) => normalizeProviderId(providerId) === normalizedProvider,
  );
}

function allowPluginModelNormalizationForRef(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  if (!normalizePluginsConfig(params.cfg.plugins).enabled && hasConfiguredProvider(params)) {
    return false;
  }
  return !hasExactConfiguredProviderModel(params);
}

export function normalizeAgentCommandModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  return normalizeModelRef(provider, model, {
    ...modelManifestContext,
    allowPluginNormalization: allowPluginModelNormalizationForRef({ cfg, provider, model }),
  });
}

export function normalizeAgentCommandDefaultModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const normalizedProvider = normalizeProviderId(provider);
  if (hasConfiguredProvider({ cfg, provider: normalizedProvider })) {
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
  raw: string,
  defaultProvider: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const parsed = resolveModelRefFromString({
    cfg,
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg,
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
