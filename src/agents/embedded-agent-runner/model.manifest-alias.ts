import type { ModelCatalogAlias } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planManifestModelCatalogSuppressions } from "../../model-catalog/manifest-planner.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
} from "../../plugins/manifest-owner-policy.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import { staticModelIdMatches } from "./model.static-id.js";

function hasModelCatalogAliasTransportOverride(alias: ModelCatalogAlias): boolean {
  return Boolean(alias.api?.trim() || alias.baseUrl?.trim());
}

function hasModelCatalogAliasEndpointSurface(alias: ModelCatalogAlias): boolean {
  return Boolean(alias.baseUrl?.trim());
}

function findConfiguredModelCatalogProviderConfig(params: {
  provider: string;
  cfg?: OpenClawConfig;
}): Partial<ModelProviderConfig> | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return undefined;
  }
  for (const [providerId, providerConfig] of Object.entries(params.cfg?.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) === provider) {
      return providerConfig;
    }
  }
  return undefined;
}

function hasConfiguredModelCatalogProviderEndpointSurface(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  const config = findConfiguredModelCatalogProviderConfig({ provider, cfg: params.cfg });
  if (config?.baseUrl?.trim()) {
    return true;
  }
  const modelId = params.modelId?.trim();
  if (!modelId || !Array.isArray(config?.models)) {
    return false;
  }
  return config.models.some(
    (model) =>
      Boolean(model.baseUrl?.trim()) &&
      staticModelIdMatches({
        candidateId: model.id,
        provider,
        modelId,
      }),
  );
}

function resolveConfiguredModelCatalogProviderApi(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
}): ModelCatalogAlias["api"] {
  const provider = normalizeProviderId(params.provider);
  const config = findConfiguredModelCatalogProviderConfig({ provider, cfg: params.cfg });
  const modelId = params.modelId?.trim();
  const model =
    provider && modelId && Array.isArray(config?.models)
      ? config.models.find((candidate) =>
          staticModelIdMatches({ candidateId: candidate.id, provider, modelId }),
        )
      : undefined;
  return model?.api ?? config?.api;
}

function hasUnconditionalManifestModelCatalogSuppression(params: {
  provider: string;
  modelId?: string;
  plugin: Pick<PluginManifestRecord, "id" | "providers" | "modelCatalog">;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return false;
  }
  return planManifestModelCatalogSuppressions({
    registry: { plugins: [params.plugin] },
    providerFilter: provider,
    modelFilter: modelId,
  }).suppressions.some(
    (suppression) => !suppression.when && normalizeProviderId(suppression.provider) === provider,
  );
}

type ManifestModelCatalogAliasPlugin = Pick<
  PluginManifestRecord,
  | "id"
  | "origin"
  | "enabledByDefault"
  | "enabledByDefaultOnPlatforms"
  | "providers"
  | "modelCatalog"
>;

type ManifestModelCatalogProviderTransport = Readonly<Pick<ModelCatalogAlias, "api" | "baseUrl">>;

export type ManifestModelCatalogProviderAliasMetadata = {
  readonly ambiguous?: true;
  readonly provider: string;
  readonly transport?: ManifestModelCatalogProviderTransport;
};

type ManifestModelCatalogProviderAliasClaim = {
  readonly incompleteTransport: boolean;
  readonly targetProvider: string;
  readonly retainsTransportAlias: boolean;
  readonly transport: ManifestModelCatalogProviderTransport;
};

type ManifestModelCatalogProviderAliasResolution =
  | { readonly kind: "none" }
  | { readonly kind: "conflict" }
  | { readonly kind: "incomplete-transport" }
  | { readonly kind: "canonical"; readonly provider: string }
  | {
      readonly kind: "transport";
      readonly transport: ManifestModelCatalogProviderTransport;
    };

function listEligibleManifestModelCatalogAliasPlugins(params: {
  cfg?: OpenClawConfig;
  plugins: readonly ManifestModelCatalogAliasPlugin[];
}): readonly ManifestModelCatalogAliasPlugin[] {
  const normalizedConfig = normalizePluginsConfig(params.cfg?.plugins);
  return params.plugins.filter((plugin) => {
    if (
      !isActivatedManifestOwner({
        plugin,
        normalizedConfig,
        rootConfig: params.cfg,
      })
    ) {
      return false;
    }
    return (
      isBundledManifestOwner(plugin) ||
      plugin.origin === "config" ||
      hasExplicitManifestOwnerTrust({ plugin, normalizedConfig })
    );
  });
}

function resolveManifestAliasTargetApi(params: {
  plugin: ManifestModelCatalogAliasPlugin;
  provider: string;
  modelId?: string;
}): ModelCatalogAlias["api"] {
  const providerCatalog = Object.entries(params.plugin.modelCatalog?.providers ?? {}).find(
    ([provider]) => normalizeProviderId(provider) === params.provider,
  )?.[1];
  if (!providerCatalog) {
    return undefined;
  }
  const modelId = params.modelId?.trim();
  const model = modelId
    ? providerCatalog.models.find((candidate) =>
        staticModelIdMatches({
          candidateId: candidate.id,
          provider: params.provider,
          modelId,
        }),
      )
    : undefined;
  return model?.api ?? providerCatalog.api;
}

function resolveManifestModelCatalogProviderAlias(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
  plugins: readonly ManifestModelCatalogAliasPlugin[];
}): ManifestModelCatalogProviderAliasResolution {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return { kind: "none" };
  }
  const claims: ManifestModelCatalogProviderAliasClaim[] = [];
  const plugins = listEligibleManifestModelCatalogAliasPlugins({
    cfg: params.cfg,
    plugins: params.plugins,
  });
  for (const plugin of plugins) {
    for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const normalizedAlias = normalizeProviderId(rawAlias);
      const normalizedTarget = normalizeProviderId(alias.provider);
      if (
        normalizedAlias !== provider ||
        !normalizedTarget ||
        !plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedTarget)
      ) {
        continue;
      }
      const hasModelId = Boolean(params.modelId?.trim());
      const hasApplicableSuppression =
        hasModelId &&
        hasUnconditionalManifestModelCatalogSuppression({
          provider,
          modelId: params.modelId,
          plugin,
        });
      const hasEndpointSurface =
        hasModelCatalogAliasEndpointSurface(alias) ||
        hasConfiguredModelCatalogProviderEndpointSurface({
          provider,
          modelId: params.modelId,
          cfg: params.cfg,
        });
      const transportApi =
        resolveConfiguredModelCatalogProviderApi({
          provider,
          modelId: params.modelId,
          cfg: params.cfg,
        }) ??
        alias.api ??
        resolveManifestAliasTargetApi({
          plugin,
          provider: normalizedTarget,
          modelId: params.modelId,
        });
      const hasTransportOverride = hasModelCatalogAliasTransportOverride(alias);
      const retainsTransportAlias =
        hasTransportOverride &&
        hasEndpointSurface &&
        Boolean(transportApi) &&
        !hasApplicableSuppression;
      const baseUrl = alias.baseUrl?.trim();
      claims.push({
        // A retained endpoint needs an explicit wire adapter. Otherwise the generic
        // model fallback would silently choose OpenAI Responses for another provider.
        incompleteTransport:
          hasTransportOverride && hasEndpointSurface && !transportApi && !hasApplicableSuppression,
        targetProvider: normalizedTarget,
        retainsTransportAlias,
        transport: {
          ...(transportApi ? { api: transportApi } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        },
      });
    }
  }
  if (claims.length === 0) {
    return { kind: "none" };
  }
  if (claims.length > 1) {
    return { kind: "conflict" };
  }
  const claim = claims[0];
  if (!claim) {
    return { kind: "none" };
  }
  if (claim.incompleteTransport) {
    return { kind: "incomplete-transport" };
  }
  if (claim.retainsTransportAlias) {
    return {
      kind: "transport",
      transport: claim.transport,
    };
  }
  return {
    kind: "canonical",
    provider: claim.targetProvider,
  };
}

export function resolveManifestModelCatalogProviderAliasMetadata(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ManifestModelCatalogProviderAliasMetadata {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return { provider: params.provider };
  }
  const env = params.env ?? process.env;
  // Gateway plugin metadata is process-stable. Reuse its lifecycle-owned snapshot
  // so every model turn does not rediscover the same manifest alias table.
  const currentPlugins =
    env === process.env
      ? getCurrentPluginMetadataSnapshot({
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env,
          ...(params.cfg === undefined ? { requireDefaultDiscoveryContext: true } : {}),
        })?.plugins
      : undefined;
  const plugins =
    currentPlugins ??
    loadPluginManifestRegistry({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
    }).plugins;
  const resolved = resolveManifestModelCatalogProviderAlias({
    provider,
    modelId: params.modelId,
    cfg: params.cfg,
    plugins,
  });
  switch (resolved.kind) {
    case "canonical":
      return { provider: resolved.provider };
    case "transport":
      return { provider: params.provider, transport: resolved.transport };
    case "conflict":
    case "incomplete-transport":
      return { provider: params.provider, ambiguous: true };
    case "none":
      return { provider: params.provider };
    default: {
      const exhaustive: never = resolved;
      return exhaustive;
    }
  }
}
