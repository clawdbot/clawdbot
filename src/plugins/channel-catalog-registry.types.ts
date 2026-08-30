import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { PluginDiscoveryResult } from "./discovery.types.js";
import type { PluginPackageChannel, PluginPackageInstall } from "./package-manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

export type PluginChannelCatalogEntry = {
  pluginId: string;
  origin: PluginOrigin;
  packageName?: string;
  workspaceDir?: string;
  rootDir: string;
  channel: PluginPackageChannel;
  install?: PluginPackageInstall;
};

export type ChannelCatalogParams = {
  origin?: PluginOrigin;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  extraPaths?: string[];
  /**
   * Optional override. Prepared catalogs require matching retained records;
   * cold callers load the ledger when omitted, except for bundled-only reads.
   */
  installRecords?: Record<string, PluginInstallRecord>;
  discovery?: PluginDiscoveryResult;
};

export type PreparedPluginChannelCatalog = {
  readonly read: (params: ChannelCatalogParams) => PluginChannelCatalogEntry[];
};
