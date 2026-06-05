// Model auth runtime types describe provider auth state exposed to plugin runtimes.
import type { ResolvedProviderAuth } from "../../agents/model-auth-runtime-shared.js";
import type { ModelProviderRequestTransportOverrides } from "../../agents/provider-request-config.js";

/**
 * Runtime-ready auth result exposed to native plugins and context engines.
 *
 * `source`, `mode`, and `profileId` describe how the original credential was
 * resolved. `apiKey` is the request-ready credential after any provider-owned
 * runtime exchange, so it may differ from the stored/raw credential.
 */
export type ResolvedProviderRuntimeAuth = Omit<ResolvedProviderAuth, "apiKey"> & {
  apiKey?: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};
