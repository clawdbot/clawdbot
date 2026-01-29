export type PluginEntryConfig = {
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /**
   * Select which plugin(s) own the memory slot.
   * - Single string: "memory-lancedb" - one plugin active
   * - Array: ["memory-core", "memory-lancedb"] - multiple plugins active (stackable)
   * - "none": disables all memory plugins
   */
  memory?: string | string[];
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginInstallRecord = {
  source: "npm" | "archive" | "path";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
};
