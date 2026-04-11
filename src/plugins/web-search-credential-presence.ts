import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

export function hasConfiguredWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig?: Record<string, unknown>;
  origin?: PluginManifestRecord["origin"];
  bundledAllowlistCompat?: boolean;
}): boolean {
  const searchConfig =
    params.searchConfig ??
    (params.config.tools?.web?.search as Record<string, unknown> | undefined);
  return resolvePluginWebSearchProviders({
    config: params.config,
    env: params.env,
    bundledAllowlistCompat: params.bundledAllowlistCompat ?? false,
    origin: params.origin,
  }).some((provider) => {
    const configuredCredential =
      provider.getConfiguredCredentialValue?.(params.config) ??
      provider.getCredentialValue(searchConfig);
    if (hasConfiguredCredentialValue(configuredCredential)) {
      return true;
    }
    return provider.envVars.some((envVar) => hasConfiguredCredentialValue(params.env?.[envVar]));
  });
}
