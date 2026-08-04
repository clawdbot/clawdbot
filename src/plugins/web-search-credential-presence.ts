// Checks web-search credential presence from config and plugin metadata.
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { manifestConfigSignalPasses } from "./manifest-tool-availability.js";

function hasConfiguredCredentialValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

function hasConfiguredSearchCredentialCandidate(
  searchConfig: unknown,
): boolean {
  const record = asOptionalObjectRecord(searchConfig);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(
    ([key, value]) => key !== "enabled" && hasConfiguredCredentialValue(value),
  );
}

function hasConfiguredPluginWebSearchCandidate(
  config: OpenClawConfig,
): boolean {
  const entries = asOptionalObjectRecord(config.plugins?.entries);
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => {
    const pluginConfig = asOptionalObjectRecord(entry)?.config;
    return hasConfiguredSearchCredentialCandidate(
      asOptionalObjectRecord(pluginConfig)?.webSearch,
    );
  });
}

function hasManifestWebSearchCredentialCandidate(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  return loadManifestMetadataSnapshot({
    config: params.config,
    env: params.env,
  }).plugins.some((plugin) => {
    if (params.origin && plugin.origin !== params.origin) {
      return false;
    }
    const providerIds = plugin.contracts?.webSearchProviders ?? [];
    if (providerIds.length === 0) {
      return false;
    }
    if (
      providerIds.some((providerId) =>
        plugin.webSearchProviderMetadata?.[providerId]?.configSignals?.some(
          (signal) =>
            manifestConfigSignalPasses({
              config: params.config,
              env: params.env ?? process.env,
              signal,
            }),
        ),
      )
    ) {
      return true;
    }
    if (!params.env) {
      return false;
    }
    const envVars = (plugin.setup?.providers ?? []).flatMap(
      (provider) => provider.envVars ?? [],
    );
    return envVars.some((envVar) =>
      hasConfiguredCredentialValue(params.env?.[envVar]),
    );
  });
}

export function hasConfiguredWebSearchCredential(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  searchConfig?: Record<string, unknown>;
  origin?: PluginManifestRecord["origin"];
}): boolean {
  const searchConfig =
    params.searchConfig ??
    (params.config.tools?.web?.search as Record<string, unknown> | undefined);
  return (
    hasConfiguredSearchCredentialCandidate(searchConfig) ||
    hasConfiguredPluginWebSearchCandidate(params.config) ||
    hasManifestWebSearchCredentialCandidate({
      config: params.config,
      env: params.env,
      origin: params.origin,
    })
  );
}
