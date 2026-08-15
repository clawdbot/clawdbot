/** Cold adapter for provider-owned OpenAI model route facts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteResolution,
  ProviderModelRouteSource,
  ProviderRouteOverridePresence,
} from "../plugin-sdk/provider-model-types.js";
import { createProviderModelRoutesResolver } from "../plugins/provider-model-routes.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import type { ProviderModelAuthSourcePlan } from "./provider-model-auth-source-plan.js";
import { selectProviderModelRouteAuth } from "./provider-model-route-auth.js";
import { createProviderModelCatalogRoutePolicy } from "./provider-model-route.js";

const OPENAI_PROVIDER_ID = "openai";

export function createOpenAIModelRoutesResolver(params: {
  config?: OpenClawConfig;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
}) {
  const resolveRoutes = createProviderModelRoutesResolver({
    provider: OPENAI_PROVIDER_ID,
    config: params.config,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  return (observed: {
    modelId?: string;
    api?: string | null;
    baseUrl?: unknown;
    observedRoutes?: readonly ProviderModelRouteSource[];
  }) =>
    resolveRoutes({
      modelId: observed.modelId ? splitTrailingAuthProfile(observed.modelId).model : undefined,
      observedRoutes:
        observed.observedRoutes ??
        (observed.api != null || (observed.baseUrl !== undefined && observed.baseUrl !== null)
          ? [
              {
                api: observed.api as ModelApi | null | undefined,
                baseUrl: observed.baseUrl,
              },
            ]
          : undefined),
    });
}

/** Returns the authored OpenAI provider auth mode, if one exists. */
export function resolveConfiguredOpenAIAuthMode(config?: OpenClawConfig): string | undefined {
  return resolveMergedModelProviderConfig(config, OPENAI_PROVIDER_ID)?.auth;
}

export function selectOpenAIModelRouteAuth(params: {
  resolution: Parameters<typeof selectProviderModelRouteAuth>[0]["resolution"];
  sourcePlan: ProviderModelAuthSourcePlan;
  configuredAuthMode?: string;
  runtimeAuthOwner?: { id: string };
}) {
  return selectProviderModelRouteAuth({ provider: OPENAI_PROVIDER_ID, ...params });
}

export const openAIModelCatalogRoutePolicy =
  createProviderModelCatalogRoutePolicy(OPENAI_PROVIDER_ID);

/** Resolves provider-owned OpenAI route state without loading the full provider runtime. */
export function resolveOpenAIModelRoutes(params: {
  provider?: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: unknown;
  config?: OpenClawConfig;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
}): ProviderModelRouteResolution | null {
  if (normalizeProviderId(params.provider ?? "") !== OPENAI_PROVIDER_ID) {
    return null;
  }
  return createOpenAIModelRoutesResolver({
    config: params.config,
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  })({
    modelId: params.modelId,
    api: params.api as ModelApi | null | undefined,
    baseUrl: params.baseUrl,
  });
}
