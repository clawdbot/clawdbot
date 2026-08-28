import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderModelRouteCandidate,
  ProviderModelRouteResolution,
} from "../plugin-sdk/provider-model-types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import type { createOpenAIModelRoutesResolver } from "./openai-model-routes.js";

export const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} satisfies ProviderModelRouteCandidate;

export const subscriptionRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
} satisfies ProviderModelRouteCandidate;

export const dualRoutes = {
  kind: "routes",
  defaultRuntimeId: "codex",
  routes: [platformRoute, subscriptionRoute],
} satisfies ProviderModelRouteResolution;

export function routeResolverFactory(resolution: ProviderModelRouteResolution | null) {
  return (() => () => resolution) as typeof createOpenAIModelRoutesResolver;
}

export function authStore(
  profiles: Record<string, unknown> = {},
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return {
    version: 1,
    profiles: profiles as AuthProfileStore["profiles"],
    ...(order ? { order } : {}),
  };
}

export function evaluate(params: {
  cfg?: OpenClawConfig | Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  ref?: ModelAuthAvailabilityRef;
  resolution?: ProviderModelRouteResolution | null;
  store?: AuthProfileStore;
  preparedRuntimeAuthStore?: AuthProfileStore;
  syntheticAuthProviderRefs?: readonly string[];
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
}) {
  return createModelAuthAvailabilityResolver({
    cfg: (params.cfg ?? {}) as OpenClawConfig,
    authStore: params.store ?? authStore(),
    env: params.env ?? {},
    routeResolverFactory: routeResolverFactory(params.resolution ?? dualRoutes),
    syntheticAuthProviderRefs: params.syntheticAuthProviderRefs,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthStore: params.preparedRuntimeAuthStore,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
  }).evaluateModelAuth("openai", params.ref);
}
