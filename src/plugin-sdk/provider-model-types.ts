/**
 * Public SDK type surface for model provider and model definition config.
 */
import type { ModelApi } from "../config/types.models.js";

export type {
  BedrockDiscoveryConfig,
  ModelApi,
  ModelCompatConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";

export type ProviderModelRouteSource = {
  api?: ModelApi | null;
  baseUrl?: unknown;
};

/** A concrete provider route. Order expresses provider default, never credential precedence. */
export type ProviderModelRouteAuthRequirement = "api-key" | "subscription";
export type ProviderRouteOverridePresence = "none" | "present";
export type ProviderModelRouteRuntimePolicy = {
  /** Agent runtime ids that can reproduce this route without losing transport behavior. */
  compatibleIds: readonly string[];
};

export type ProviderModelRouteCandidate = {
  api: ModelApi;
  baseUrl: string;
  authRequirement: ProviderModelRouteAuthRequirement;
  /** Secret-free summary of request behavior the selected runtime must reproduce. */
  requestTransportOverrides: ProviderRouteOverridePresence;
  /** Provider-owned native-runtime compatibility for this concrete route. */
  runtimePolicy?: ProviderModelRouteRuntimePolicy;
};

export type ProviderModelRouteResolution =
  | {
      kind: "routes";
      routes: readonly [ProviderModelRouteCandidate, ...ProviderModelRouteCandidate[]];
      /** Advisory only; authored agentRuntime policy remains authoritative. */
      defaultRuntimeId?: string;
    }
  | {
      kind: "indeterminate";
      /** Advisory only; preserves the provider's implicit runtime while route facts are absent. */
      defaultRuntimeId?: string;
    }
  | {
      kind: "incompatible";
      code: string;
      message: string;
    };

export type ProviderResolveModelRoutesContext = {
  provider: string;
  modelId?: string;
  /** Effective secret-free request behavior for this provider/model pair. */
  requestTransportOverrides?: ProviderRouteOverridePresence;
  configuredModel?: ProviderModelRouteSource;
  configuredProvider?: ProviderModelRouteSource;
  /** Environment view; the provider owns interpretation of its variables. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Physical route facts for one logical model; input order is not preference. */
  observedRoutes?: readonly ProviderModelRouteSource[];
};

export type ProviderNormalizeModelCatalogIdContext = {
  provider: string;
  modelId: string;
};
