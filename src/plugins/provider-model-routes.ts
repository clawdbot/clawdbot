/** Generic adapter for provider-owned model route public artifacts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
  resolveModelProviderRouteOverridePresence,
} from "../config/model-provider-config.js";
import type { ModelApi, ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
  ProviderRouteOverridePresence,
} from "../plugin-sdk/provider-model-types.js";
import {
  resolveDirectBundledProviderPolicySurface,
  type BundledProviderPolicySurface,
} from "./provider-policy-surface.js";

type ProviderModelRouteObservation = {
  modelId?: string;
  observedRoutes?: readonly ProviderModelRouteSource[];
};

type ProviderModelRoutesResolver = (
  observed?: ProviderModelRouteObservation,
) => ProviderModelRouteResolution | null;

/** Resolves provider-owned catalog id equivalence without loading its runtime. */
export function resolveProviderModelCatalogId(params: {
  provider: string;
  modelId: string;
  surface?: BundledProviderPolicySurface | null;
}): string | null {
  const provider = normalizeProviderId(params.provider);
  const surface =
    params.surface === undefined
      ? resolveDirectBundledProviderPolicySurface(provider)
      : params.surface;
  const normalized = surface?.normalizeModelCatalogId?.({
    provider,
    modelId: params.modelId,
  });
  return typeof normalized === "string" && normalized.trim() ? normalized.trim() : null;
}

function normalizeModelId(
  provider: string,
  modelId: string | undefined,
  surface?: BundledProviderPolicySurface | null,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const canonical = surface?.normalizeModelCatalogId?.({ provider, modelId: trimmed });
  return typeof canonical === "string" && canonical.trim() ? canonical.trim() : trimmed;
}

function projectConfiguredModelRoute(model: ModelDefinitionConfig): ProviderModelRouteSource {
  return {
    ...(Object.hasOwn(model, "api") ? { api: model.api } : {}),
    ...(Object.hasOwn(model, "baseUrl") ? { baseUrl: model.baseUrl } : {}),
  };
}

/** Captures one provider artifact and config view for repeated row resolution. */
export function createProviderModelRoutesResolver(params: {
  provider: string;
  config?: OpenClawConfig;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  surface?: BundledProviderPolicySurface | null;
}): ProviderModelRoutesResolver {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return () => null;
  }
  // Runtime selection is a hot path and currently has one canonical OpenAI
  // owner. Alias/secondary-owner discovery remains on the cold artifact path.
  const surface =
    params.surface === undefined
      ? resolveDirectBundledProviderPolicySurface(provider)
      : params.surface;
  const resolveModelRoutes = surface?.resolveModelRoutes;
  const providerConfig = resolveMergedModelProviderConfig(params.config, provider);
  const configuredProvider = providerConfig
    ? { api: providerConfig.api, baseUrl: providerConfig.baseUrl }
    : undefined;
  const normalizeConfiguredModelId = (modelId: string) =>
    normalizeModelId(provider, modelId, surface);
  const canonicalizeModelId = (modelId: string) =>
    normalizeConfiguredModelId(modelId) ?? modelId.trim();
  const configuredModels = new Map(
    Array.from(
      resolveMergedModelProviderModels({
        models: providerConfig?.models,
        normalizeModelId: normalizeConfiguredModelId,
      }),
      ([modelId, model]) => [modelId, projectConfiguredModelRoute(model)] as const,
    ),
  );
  const providerRouteOverridePresence =
    params.requestTransportOverrides === "present"
      ? "present"
      : resolveModelProviderRouteOverridePresence({
          provider,
          config: params.config,
        });
  const routeOverridePresenceByModel = new Map(
    [...configuredModels.keys()].map(
      (modelId) =>
        [
          modelId,
          params.requestTransportOverrides === "present"
            ? "present"
            : resolveModelProviderRouteOverridePresence({
                provider,
                modelId,
                config: params.config,
                canonicalizeModelId,
              }),
        ] as const,
    ),
  );
  const env = params.env ?? process.env;

  return (observed) => {
    if (!resolveModelRoutes) {
      return null;
    }
    const modelId = normalizeModelId(provider, observed?.modelId, surface);
    const configuredModel = modelId ? configuredModels.get(modelId) : undefined;
    const requestTransportOverrides = modelId
      ? (routeOverridePresenceByModel.get(modelId) ?? providerRouteOverridePresence)
      : providerRouteOverridePresence;
    const observedRoutes = observed?.observedRoutes?.filter(
      (route) => route.api != null || (route.baseUrl !== undefined && route.baseUrl !== null),
    );
    return (
      resolveModelRoutes({
        provider,
        ...(modelId ? { modelId } : {}),
        requestTransportOverrides,
        ...(configuredModel ? { configuredModel } : {}),
        ...(configuredProvider ? { configuredProvider } : {}),
        env,
        ...(observedRoutes && observedRoutes.length > 0 ? { observedRoutes } : {}),
      }) ?? null
    );
  };
}

/** Resolves one model route through its bundled provider public artifact. */
export function resolveProviderModelRoutes(params: {
  provider: string;
  modelId?: string;
  api?: ModelApi | null;
  baseUrl?: unknown;
  config?: OpenClawConfig;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
  surface?: BundledProviderPolicySurface | null;
}): ProviderModelRouteResolution | null {
  const resolveRoutes = createProviderModelRoutesResolver(params);
  return resolveRoutes({
    modelId: params.modelId,
    observedRoutes:
      params.api != null || (params.baseUrl !== undefined && params.baseUrl !== null)
        ? [{ api: params.api, baseUrl: params.baseUrl }]
        : undefined,
  });
}
