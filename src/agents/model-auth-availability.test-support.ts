import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteResolution } from "../plugin-sdk/provider-model-types.js";
import type { PreparedProviderAuth } from "./agent-auth-credential-modes.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityRef,
} from "./model-auth-availability.js";
import { dualRoutes, openAIModelRoutesMock } from "./openai-model-routes.test-support.js";

export {
  dualRoutes,
  platformRoute,
  subscriptionRoute,
} from "./openai-model-routes.test-support.js";

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
  preparedProviderAuth?: PreparedProviderAuth;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
}) {
  openAIModelRoutesMock.resolution = params.resolution ?? dualRoutes;
  return createModelAuthAvailabilityResolver({
    cfg: (params.cfg ?? {}) as OpenClawConfig,
    authStore: params.store ?? authStore(),
    env: params.env ?? {},
    syntheticAuthProviderRefs: params.syntheticAuthProviderRefs,
    preparedProviderAuth: params.preparedProviderAuth,
    preparedRuntimeAuthStore: params.preparedRuntimeAuthStore,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
  }).evaluateModelAuth("openai", params.ref);
}
