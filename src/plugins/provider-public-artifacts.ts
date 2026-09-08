import path from "node:path";
// Extracts provider public artifacts from plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import {
  resolveDirectBundledProviderPolicySurface,
  resolveTrustedExternalProviderPolicySurface,
  type BundledProviderPolicySurface,
  type ProviderPolicySurface,
} from "./provider-policy-surface.js";

type ProviderPolicyMetadata = {
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  loadManifestRegistry?: () => Pick<PluginManifestRegistry, "plugins"> | undefined;
};

function resolveBundledProviderPolicyPlugin(
  providerId: string,
  options: ProviderPolicyMetadata = {},
): PluginManifestRegistry["plugins"][number] | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const bundledPluginsDir = resolveBundledPluginsDir();
  if (!bundledPluginsDir) {
    return null;
  }

  const registry =
    options.manifestRegistry ??
    options.loadManifestRegistry?.() ??
    loadPluginManifestRegistryCore();
  for (const plugin of registry.plugins.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (pluginOwnsProviderPolicyRef(plugin, normalizedProviderId)) {
      return plugin;
    }
  }

  return null;
}

function pluginOwnsProviderPolicyRef(
  plugin: PluginManifestRegistry["plugins"][number],
  normalizedProviderId: string,
): boolean {
  const ownedProviders = new Set(
    [...plugin.providers, ...plugin.cliBackends, ...(plugin.contracts?.embeddingProviders ?? [])]
      .map((provider) => normalizeProviderId(provider))
      .filter(Boolean),
  );
  if (ownedProviders.has(normalizedProviderId)) {
    return true;
  }

  for (const [rawAlias, rawTarget] of Object.entries(plugin.providerAuthAliases ?? {})) {
    const alias = normalizeProviderId(rawAlias);
    if (typeof rawTarget !== "string") {
      continue;
    }
    const target = normalizeProviderId(rawTarget);
    if (alias === normalizedProviderId && ownedProviders.has(target)) {
      return true;
    }
  }

  return false;
}

/** Resolves provider policy hooks for a bundled provider or its owning plugin. */
export function resolveBundledProviderPolicySurface(
  providerId: string,
  options: ProviderPolicyMetadata = {},
): BundledProviderPolicySurface | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId) {
    return null;
  }
  const directSurface = resolveDirectBundledProviderPolicySurface(normalizedProviderId);
  if (directSurface) {
    return directSurface;
  }
  const ownerPlugin = resolveBundledProviderPolicyPlugin(normalizedProviderId, options);
  if (ownerPlugin) {
    const ownerSurface = resolveDirectBundledProviderPolicySurface(ownerPlugin.id);
    if (ownerSurface) {
      return ownerSurface;
    }
  }
  if (!ownerPlugin) {
    return null;
  }
  // A stable plugin id can differ from its stock directory name. Use the
  // registry-owned root basename so its pre-runtime policy stays discoverable.
  return resolveDirectBundledProviderPolicySurface(path.basename(ownerPlugin.rootDir));
}

/** Resolves provider policy hooks from bundled or trusted official plugin artifacts. */
export function resolveProviderPolicySurface(
  providerId: string,
  options: { manifestRegistry?: Pick<PluginManifestRegistry, "plugins"> } = {},
): ProviderPolicySurface | null {
  const bundledSurface = resolveBundledProviderPolicySurface(providerId, options);
  if (bundledSurface) {
    return bundledSurface;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!normalizedProviderId || !options.manifestRegistry) {
    return null;
  }
  return (
    loadTrustedExternalProviderPolicyArtifacts(
      listTrustedExternalProviderPolicyOwners(providerId, options.manifestRegistry),
    )?.surface ?? null
  );
}

/** Loads the first usable policy surface from caller-selected trusted owners. */
export function loadTrustedExternalProviderPolicyArtifacts(
  owners: PluginManifestRegistry["plugins"],
) {
  for (const owner of owners) {
    const surface = resolveTrustedExternalProviderPolicySurface({
      pluginId: owner.id,
      pluginRoot: owner.rootDir,
      trustedOfficialInstall: owner.trustedOfficialInstall,
    });
    if (surface) {
      return { owner, surface };
    }
  }
  const owner = owners[0];
  return owner ? { owner, surface: null } : null;
}

/** Lists trusted installed plugins that own a provider policy reference. */
export function listTrustedExternalProviderPolicyOwners(
  providerId: string,
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">,
) {
  const normalizedProviderId = normalizeProviderId(providerId);
  return manifestRegistry.plugins
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .filter(
      (plugin) =>
        plugin.trustedOfficialInstall === true &&
        pluginOwnsProviderPolicyRef(plugin, normalizedProviderId),
    );
}
