/** Source class for plugin registry snapshots used by diagnostics and cache decisions. */
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";

export type PluginRegistryDifference = {
  pluginId: string;
  persistedSource: string | null;
  derivedSource: string | null;
};

export type PluginRegistrySnapshotDiagnostic = {
  level: "info" | "warn";
  code:
    | "persisted-registry-missing"
    | "persisted-registry-stale-policy"
    | "persisted-registry-stale-source";
  message: string;
  differences?: readonly PluginRegistryDifference[];
};
