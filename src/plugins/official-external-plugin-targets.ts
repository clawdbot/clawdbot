// Lightweight static projections for deciding whether plugin repair can be skipped.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES } from "./official-external-plugin-bundled-catalogs.js";
import type { OfficialExternalPluginCatalogManifest } from "./official-external-plugin-catalog.types.js";

function normalizeIds(values: Iterable<string>): Set<string> {
  return new Set(
    [...values]
      .map((value) => normalizeOptionalLowercaseString(value))
      .filter((value): value is string => Boolean(value)),
  );
}

function envHasAny(env: NodeJS.ProcessEnv, names: readonly string[] | undefined): boolean {
  return names?.some((name) => Boolean(env[name]?.trim())) ?? false;
}

function envHasChannelCandidate(
  env: NodeJS.ProcessEnv,
  channel: OfficialExternalPluginCatalogManifest["channel"],
): boolean {
  const allOf = channel?.configuredState?.env?.allOf ?? [];
  const anyOf = channel?.configuredState?.env?.anyOf ?? [];
  return envHasAny(env, [...(channel?.envVars ?? []), ...allOf, ...anyOf]);
}

export function hasOfficialExternalProviderTarget(params: {
  providerIds: Iterable<string>;
  env: NodeJS.ProcessEnv;
}): boolean {
  const providerIds = normalizeIds(params.providerIds);
  return BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES.some((entry) =>
    entry.openclaw?.providers?.some(
      (provider) =>
        envHasAny(params.env, provider.envVars) ||
        [provider.id, ...(provider.aliases ?? [])].some((providerId) => {
          const normalized = normalizeOptionalLowercaseString(providerId);
          return normalized ? providerIds.has(normalized) : false;
        }),
    ),
  );
}

export function hasOfficialExternalContractTarget(params: {
  contract: keyof NonNullable<OfficialExternalPluginCatalogManifest["contracts"]>;
  providerIds: Iterable<string>;
}): boolean {
  const providerIds = normalizeIds(params.providerIds);
  if (providerIds.size === 0) {
    return false;
  }
  return BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES.some((entry) =>
    entry.openclaw?.contracts?.[params.contract]?.some((providerId) => {
      const normalized = normalizeOptionalLowercaseString(providerId);
      return normalized ? providerIds.has(normalized) : false;
    }),
  );
}

export function hasOfficialExternalWebContractEnvTarget(params: {
  contract: keyof NonNullable<OfficialExternalPluginCatalogManifest["contracts"]>;
  env: NodeJS.ProcessEnv;
}): boolean {
  return BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES.some((entry) => {
    const manifest = entry.openclaw;
    const contractIds = normalizeIds(manifest?.contracts?.[params.contract] ?? []);
    return manifest?.webSearchProviders?.some((provider) => {
      const providerId = normalizeOptionalLowercaseString(provider.id);
      return Boolean(
        providerId && contractIds.has(providerId) && envHasAny(params.env, provider.envVars),
      );
    });
  });
}

export function hasOfficialExternalChannelTarget(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): boolean {
  const channels = isRecord(params.config.channels) ? params.config.channels : undefined;
  return BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES.some((entry) => {
    const channel = entry.openclaw?.channel;
    const channelId = normalizeOptionalLowercaseString(channel?.id);
    if (!channelId) {
      return false;
    }
    const channelConfig = channels?.[channelId];
    return (
      (isRecord(channelConfig) && channelConfig.enabled !== false) ||
      envHasChannelCandidate(params.env, channel)
    );
  });
}

export function hasOfficialExternalWebSearchTarget(params: {
  providerId?: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const configuredId = normalizeOptionalLowercaseString(params.providerId);
  return BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES.some((entry) =>
    entry.openclaw?.webSearchProviders?.some((provider) => {
      const providerId = normalizeOptionalLowercaseString(provider.id);
      return (
        (configuredId !== undefined && providerId === configuredId) ||
        envHasAny(params.env, provider.envVars)
      );
    }),
  );
}
