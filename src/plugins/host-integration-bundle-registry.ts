/** Registry-scoped view of validated host integration bundle declarations. */
import type { PluginManifestHostIntegrationBundle } from "./host-integration-bundle.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PluginOrigin } from "./types.js";

export type RegisteredHostIntegrationBundle = Readonly<{
  pluginId: string;
  source: string;
  rootDir?: string;
  origin: PluginOrigin;
  bundle: PluginManifestHostIntegrationBundle;
}>;

/** Returns the enabled, non-failed bundle declarations in the supplied registry snapshot. */
export function listRegisteredHostIntegrationBundles(
  registry: Pick<PluginRegistry, "plugins">,
): readonly RegisteredHostIntegrationBundle[] {
  const registrations = registry.plugins
    .filter(
      (
        plugin,
      ): plugin is typeof plugin & {
        hostIntegrationBundle: PluginManifestHostIntegrationBundle;
      } =>
        plugin.enabled && plugin.status !== "error" && plugin.hostIntegrationBundle !== undefined,
    )
    .map((plugin) =>
      Object.freeze({
        pluginId: plugin.id,
        source: plugin.source,
        ...(plugin.rootDir ? { rootDir: plugin.rootDir } : {}),
        origin: plugin.origin,
        bundle: plugin.hostIntegrationBundle,
      }),
    )
    .toSorted(
      (left, right) =>
        left.bundle.id.localeCompare(right.bundle.id) ||
        left.pluginId.localeCompare(right.pluginId),
    );
  return Object.freeze(registrations);
}
