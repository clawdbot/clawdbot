// Shares provider registry normalization helpers across plugin paths.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { PluginRegistry } from "./registry-types.js";
import type { ProviderPlugin } from "./types.js";

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : undefined;
}

export function matchesProviderPluginRef(
  provider: { id: string; aliases?: readonly string[]; hookAliases?: readonly string[] },
  providerId: string,
): boolean {
  const normalized = normalizeProviderId(providerId);
  return Boolean(
    normalized &&
    (normalizeProviderId(provider.id) === normalized ||
      [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
        (alias) => normalizeProviderId(alias) === normalized,
      )),
  );
}

/** Builds canonical and alias lookup maps for capability providers. */
export function buildCapabilityProviderMaps<T extends { id: string; aliases?: readonly string[] }>(
  providers: readonly T[],
  normalizeId: (
    providerId: string | undefined,
  ) => string | undefined = normalizeCapabilityProviderId,
): {
  canonical: Map<string, T>;
  aliases: Map<string, T>;
} {
  const canonical = new Map<string, T>();
  const aliases = new Map<string, T>();

  for (const provider of providers) {
    const id = normalizeId(provider.id);
    if (!id) {
      continue;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  }

  return { canonical, aliases };
}

function matchesProviderLiteralId(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  return Boolean(normalized) && normalizeLowercaseStringOrEmpty(provider.id) === normalized;
}

export function listProviderRuntimePluginsInRegistry(
  registry: PluginRegistry,
): Array<ProviderPlugin & { pluginId: string }> {
  return registry.providers.map((entry) =>
    Object.assign({}, entry.provider, { pluginId: entry.pluginId }),
  );
}

/** Matches a provider hook against the selected route and its explicit config owner. */
export function matchesProviderRuntimePlugin(
  plugin: ProviderPlugin,
  provider: string,
  ownerRefs: readonly string[],
): boolean {
  return ownerRefs.length > 0
    ? matchesProviderLiteralId(plugin, provider) ||
        ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
    : matchesProviderPluginRef(plugin, provider);
}

/** Selects a provider hook while leaving registry provenance with the calling owner. */
export function findProviderRuntimePluginInRegistry(params: {
  registry: PluginRegistry;
  provider: string;
  ownerRefs: readonly string[];
  isPluginOwnerCompatible?: (pluginId: string) => boolean;
}): ProviderPlugin | undefined {
  const entry = params.registry.providers.find(({ provider: plugin, pluginId }) => {
    const matchesProvider = matchesProviderRuntimePlugin(plugin, params.provider, params.ownerRefs);
    return matchesProvider && (params.isPluginOwnerCompatible?.(pluginId) ?? true);
  });
  return entry ? Object.assign({}, entry.provider, { pluginId: entry.pluginId }) : undefined;
}
