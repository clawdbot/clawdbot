import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasConfiguredSearchCredentialCandidate(searchConfig: unknown): boolean {
  if (!isRecord(searchConfig)) {
    return false;
  }
  return Object.entries(searchConfig).some(
    ([key, value]) => key !== "enabled" && hasConfiguredCredentialValue(value),
  );
}

function hasConfiguredPluginWebSearchCandidate(config: OpenClawConfig): boolean {
  const entries = isRecord(config.plugins?.entries) ? config.plugins.entries : undefined;
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    const pluginConfig = isRecord(entry) ? entry.config : undefined;
    return isRecord(pluginConfig) && hasConfiguredSearchCredentialCandidate(pluginConfig.webSearch);
  });
}

function hasManifestWebSearchEnvCredentialCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const env = params.env;
  if (!env) {
    return false;
  }
  return loadPluginManifestRegistry({
    config: params.config,
    env,
  }).plugins.some((plugin) => {
    if (params.origin && plugin.origin !== params.origin) {
      return false;
    }
    if ((plugin.contracts?.webSearchProviders?.length ?? 0) === 0) {
      return false;
    }
    const providerAuthEnvVars = plugin.providerAuthEnvVars;
    if (!providerAuthEnvVars) {
      return false;
    }
    return Object.values(providerAuthEnvVars)
      .flat()
      .some((envVar) => hasConfiguredCredentialValue(env[envVar]));
  });
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
  if (
    !hasConfiguredSearchCredentialCandidate(searchConfig) &&
    !hasConfiguredPluginWebSearchCandidate(params.config) &&
    !hasManifestWebSearchEnvCredentialCandidate({
      config: params.config,
      env: params.env,
      origin: params.origin,
    })
  ) {
    return false;
  }
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
