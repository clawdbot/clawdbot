/** Generic core consumers for provider-owned model route facts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderEntry } from "../config/model-provider-config.js";
import type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import {
  resolveProviderModelCatalogId,
  resolveProviderModelRoutes,
} from "../plugins/provider-model-routes.js";
import type { ModelCatalogRoutePolicy } from "./model-catalog-route.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

/** Canonicalizes a model id only when its provider owns catalog equivalence. */
export function canonicalizeProviderModelId(providerId: string, modelId: string): string {
  const provider = normalizeProviderId(providerId);
  return (provider && resolveProviderModelCatalogId({ provider, modelId })) || modelId;
}

function normalizeRouteBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

function routeTupleMatches(
  source: { api?: string | null; baseUrl?: string },
  route: ProviderModelRouteCandidate,
): boolean {
  return (
    source.api === route.api &&
    typeof source.baseUrl === "string" &&
    normalizeRouteBaseUrl(source.baseUrl) === normalizeRouteBaseUrl(route.baseUrl)
  );
}

/** True when materialized model metadata belongs to the selected provider route. */
export function modelMatchesProviderModelRoute(params: {
  provider: string;
  api?: string | null;
  baseUrl?: string;
  route: ProviderModelRouteCandidate;
}): boolean {
  if (routeTupleMatches(params, params.route)) {
    return true;
  }
  if (
    typeof params.api !== "string" ||
    !params.api.trim() ||
    params.api !== params.route.api ||
    typeof params.baseUrl !== "string" ||
    !params.baseUrl.trim()
  ) {
    return false;
  }

  // Re-resolve through the owner only to canonicalize endpoint spelling.
  const configuredProvider = {
    api: params.api as ModelApi,
    baseUrl: params.baseUrl,
    models: [],
  } satisfies ModelProviderConfig;
  const provider = normalizeProviderId(params.provider);
  const resolution = resolveProviderModelRoutes({
    provider,
    config: { models: { providers: { [provider]: configuredProvider } } },
  });
  return (
    resolution?.kind === "routes" &&
    resolution.routes.some(
      (candidate) =>
        candidate.authRequirement === params.route.authRequirement &&
        routeTupleMatches(candidate, params.route),
    )
  );
}

/** Creates catalog equivalence and physical-route matching from provider facts. */
export function createProviderModelCatalogRoutePolicy(providerId: string): ModelCatalogRoutePolicy {
  const provider = normalizeProviderId(providerId);
  return {
    resolveIdentity: (entry) => {
      if (normalizeProviderId(entry.provider) !== provider) {
        return null;
      }
      const id = resolveProviderModelCatalogId({
        provider,
        modelId: splitTrailingAuthProfile(entry.id).model,
      });
      return id ? { id, key: `${provider}/${id}` } : null;
    },
    matchesRoute: (entry, route) =>
      normalizeProviderId(entry.provider) === provider &&
      modelMatchesProviderModelRoute({
        provider,
        api: entry.api,
        baseUrl: entry.baseUrl,
        route,
      }),
  };
}

/** Projects a selected route onto transient config used only for model materialization. */
export function projectProviderModelRouteConfig(params: {
  provider: string;
  config?: OpenClawConfig;
  route: ProviderModelRouteCandidate;
}): OpenClawConfig {
  const provider = normalizeProviderId(params.provider);
  const providers = params.config?.models?.providers ?? {};
  const providerEntry = resolveMergedModelProviderEntry(params.config, provider);
  const providerKey = providerEntry?.providerKey ?? provider;
  const providerConfig = providerEntry?.providerConfig ?? { models: [] };
  // Materialization exposes one selected-key owner so a normalized duplicate
  // cannot resurrect a different route after selection.
  const routeProviders = Object.fromEntries(
    Object.entries(providers).filter(
      ([candidate]) => normalizeProviderId(candidate) !== provider || candidate === providerKey,
    ),
  );
  return {
    ...params.config,
    models: {
      ...params.config?.models,
      providers: {
        ...routeProviders,
        [providerKey]: {
          ...providerConfig,
          auth: params.route.authRequirement === "subscription" ? "oauth" : "api-key",
          api: params.route.api,
          baseUrl: params.route.baseUrl,
        },
      },
    },
  };
}
