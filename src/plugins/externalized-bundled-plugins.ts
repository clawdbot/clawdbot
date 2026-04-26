export type ExternalizedBundledPluginBridge = {
  /** Plugin id used while the plugin was bundled in core. */
  bundledPluginId: string;
  /** Plugin id declared by the external package. Defaults to bundledPluginId. */
  pluginId?: string;
  /** npm spec OpenClaw should install when migrating the bundled plugin out. */
  npmSpec: string;
  /** Bundled directory name, when it differs from bundledPluginId. */
  bundledDirName?: string;
  /** Previous bundled manifest default enablement from the persisted registry. */
  enabledByDefault?: boolean;
  /** Legacy ids that should be treated as this plugin during enablement checks. */
  legacyPluginIds?: readonly string[];
  /** Channel ids that imply this plugin is enabled when configured. */
  channelIds?: readonly string[];
  /** Plugin ids this external package supersedes for channel selection. */
  preferOver?: readonly string[];
};

function normalizePluginId(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function getExternalizedBundledPluginTargetId(
  bridge: ExternalizedBundledPluginBridge,
): string {
  return normalizePluginId(bridge.pluginId) || normalizePluginId(bridge.bundledPluginId);
}

export function getExternalizedBundledPluginLookupIds(
  bridge: ExternalizedBundledPluginBridge,
): readonly string[] {
  return Array.from(
    new Set(
      [
        bridge.bundledPluginId,
        bridge.pluginId,
        ...(bridge.legacyPluginIds ?? []),
        ...(bridge.channelIds ?? []),
      ]
        .map(normalizePluginId)
        .filter(Boolean),
    ),
  );
}

export function getExternalizedBundledPluginLegacyPathSuffix(
  bridge: ExternalizedBundledPluginBridge,
): string {
  const bundledDirName = bridge.bundledDirName ?? bridge.bundledPluginId;
  return ["extensions", bundledDirName].join("/");
}
