import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsSync,
} from "./installed-plugin-index-record-reader.js";
import { resolveInstalledPluginIndexStorePath } from "./installed-plugin-index-store-path.js";
import {
  refreshPersistedInstalledPluginIndex,
  refreshPersistedInstalledPluginIndexSync,
} from "./installed-plugin-index-store.js";
import { type RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
import { recordPluginInstall, type PluginInstallUpdate } from "./installs.js";

export {
  loadInstalledPluginIndexInstallRecords,
  loadInstalledPluginIndexInstallRecordsSync,
  readPersistedInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsSync,
};

export const PLUGIN_INSTALLS_CONFIG_PATH = ["plugins", "installs"] as const;

export type InstalledPluginIndexRecordStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};

type InstalledPluginIndexRecordRefreshOptions = InstalledPluginIndexRecordStoreOptions &
  Partial<Omit<RefreshInstalledPluginIndexParams, "reason" | "installRecords">> & {
    now?: () => Date;
  };

export function resolveInstalledPluginIndexRecordsStorePath(
  options: InstalledPluginIndexRecordStoreOptions = {},
): string {
  return resolveInstalledPluginIndexStorePath(options);
}

export async function writePersistedInstalledPluginIndexInstallRecords(
  records: Record<string, PluginInstallRecord>,
  options: InstalledPluginIndexRecordRefreshOptions = {},
): Promise<string> {
  await refreshPersistedInstalledPluginIndex({
    ...options,
    reason: "source-changed",
    installRecords: records,
  });
  return resolveInstalledPluginIndexRecordsStorePath(options);
}

export function writePersistedInstalledPluginIndexInstallRecordsSync(
  records: Record<string, PluginInstallRecord>,
  options: InstalledPluginIndexRecordRefreshOptions = {},
): string {
  refreshPersistedInstalledPluginIndexSync({
    ...options,
    reason: "source-changed",
    installRecords: records,
  });
  return resolveInstalledPluginIndexRecordsStorePath(options);
}

export function withPluginInstallRecords(
  config: OpenClawConfig,
  records: Record<string, PluginInstallRecord>,
): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      installs: records,
    },
  };
}

export function withoutPluginInstallRecords(config: OpenClawConfig): OpenClawConfig {
  if (!config.plugins?.installs) {
    return config;
  }
  const { installs: _installs, ...plugins } = config.plugins;
  if (Object.keys(plugins).length === 0) {
    const { plugins: _plugins, ...rest } = config;
    return rest;
  }
  return {
    ...config,
    plugins,
  };
}

export function recordPluginInstallInRecords(
  records: Record<string, PluginInstallRecord>,
  update: PluginInstallUpdate,
): Record<string, PluginInstallRecord> {
  return recordPluginInstall({ plugins: { installs: records } }, update).plugins?.installs ?? {};
}

export function removePluginInstallRecordFromRecords(
  records: Record<string, PluginInstallRecord>,
  pluginId: string,
): Record<string, PluginInstallRecord> {
  const { [pluginId]: _removed, ...rest } = records;
  return rest;
}
