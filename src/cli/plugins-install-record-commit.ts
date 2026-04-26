import { replaceConfigFile } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  loadInstalledPluginIndexInstallRecords,
  PLUGIN_INSTALLS_CONFIG_PATH,
  withoutPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";

function mergeUnsetPaths(
  left?: ConfigWriteOptions["unsetPaths"],
  right?: ConfigWriteOptions["unsetPaths"],
): ConfigWriteOptions["unsetPaths"] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? merged : undefined;
}

type ConfigCommit = (config: OpenClawConfig, writeOptions?: ConfigWriteOptions) => Promise<void>;

async function commitPluginInstallRecordsWithWriter(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  writeOptions?: ConfigWriteOptions;
  commit: ConfigCommit;
}): Promise<void> {
  const previousInstallRecords =
    params.previousInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  await writePersistedInstalledPluginIndexInstallRecords(params.nextInstallRecords);
  try {
    await params.commit(params.nextConfig, {
      ...params.writeOptions,
      unsetPaths: mergeUnsetPaths(params.writeOptions?.unsetPaths, [
        Array.from(PLUGIN_INSTALLS_CONFIG_PATH),
      ]),
    });
  } catch (error) {
    try {
      await writePersistedInstalledPluginIndexInstallRecords(previousInstallRecords);
    } catch (rollbackError) {
      throw new Error(
        "Failed to commit plugin install records and could not restore the previous plugin index",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function commitPluginInstallRecordsWithConfig(params: {
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords: Record<string, PluginInstallRecord>;
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<void> {
  await commitPluginInstallRecordsWithWriter({
    ...params,
    commit: async (nextConfig, writeOptions) => {
      await replaceConfigFile({
        nextConfig,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
        ...(writeOptions ? { writeOptions } : {}),
      });
    },
  });
}

export async function commitConfigWriteWithPendingPluginInstalls(params: {
  nextConfig: OpenClawConfig;
  writeOptions?: ConfigWriteOptions;
  commit: ConfigCommit;
}): Promise<{
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  movedInstallRecords: boolean;
}> {
  const pendingInstallRecords = params.nextConfig.plugins?.installs ?? {};
  if (Object.keys(pendingInstallRecords).length === 0) {
    if (params.writeOptions) {
      await params.commit(params.nextConfig, params.writeOptions);
    } else {
      await params.commit(params.nextConfig);
    }
    return {
      config: params.nextConfig,
      installRecords: {},
      movedInstallRecords: false,
    };
  }

  const previousInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const nextInstallRecords = {
    ...previousInstallRecords,
    ...pendingInstallRecords,
  };
  const strippedConfig = withoutPluginInstallRecords(params.nextConfig);
  await commitPluginInstallRecordsWithWriter({
    previousInstallRecords,
    nextInstallRecords,
    nextConfig: strippedConfig,
    ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
    commit: params.commit,
  });
  return {
    config: strippedConfig,
    installRecords: nextInstallRecords,
    movedInstallRecords: true,
  };
}

export async function commitConfigWithPendingPluginInstalls(params: {
  nextConfig: OpenClawConfig;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
}): Promise<{
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  movedInstallRecords: boolean;
}> {
  return await commitConfigWriteWithPendingPluginInstalls({
    nextConfig: params.nextConfig,
    ...(params.writeOptions ? { writeOptions: params.writeOptions } : {}),
    commit: async (nextConfig, writeOptions) => {
      await replaceConfigFile({
        nextConfig,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
        ...(writeOptions ? { writeOptions } : {}),
      });
    },
  });
}
