import { projectModelProviderConfig } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "./provider-auth-aliases.js";

/** Endpoint-conditioned aliases follow the materialized model without changing route planning. */
export function resolveModelProviderAuthConfig(
  params: ProviderAuthAliasLookupParams & { provider: string; modelBaseUrl?: unknown },
): OpenClawConfig | undefined {
  if (typeof params.modelBaseUrl !== "string") {
    return params.config;
  }
  const config = projectModelProviderConfig(params.config, params.provider, {
    baseUrl: params.modelBaseUrl,
  });
  return resolveProviderIdForAuth(params.provider, params) ===
    resolveProviderIdForAuth(params.provider, { ...params, config })
    ? params.config
    : config;
}
