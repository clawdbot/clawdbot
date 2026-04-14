export type PluginManifestRegistryCacheEntry = {
  expiresAt: number;
  registry: unknown;
};

export const pluginManifestRegistryCache = new Map<string, PluginManifestRegistryCacheEntry>();

export function clearPluginManifestRegistryCache(): void {
  pluginManifestRegistryCache.clear();
}
