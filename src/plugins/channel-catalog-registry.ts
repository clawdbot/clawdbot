import type { PluginInstallRecord } from "../config/types.plugins.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import {
  loadPluginManifest,
  type PluginPackageChannel,
  type PluginPackageInstall,
} from "./manifest.js";
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

export function listChannelCatalogEntries(
  params: {
    origin?: PluginOrigin;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Optional override.  When omitted and `origin !== "bundled"`, the persisted
     * plugin install ledger is loaded synchronously so that npm-installed
     * channels stored outside the discovery roots are visible to the catalog.
     * Bundled-only callers skip the load to avoid the disk read.
     */
    installRecords?: Record<string, PluginInstallRecord>;
  } = {},
): PluginChannelCatalogEntry[] {
  const installRecords = resolveInstallRecords(params);
  return discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(installRecords && Object.keys(installRecords).length > 0 ? { installRecords } : {}),
  }).candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const manifest = loadPluginManifest(
      candidate.rootDir,
      shouldRejectHardlinkedPluginFiles({
        origin: candidate.origin,
        rootDir: candidate.rootDir,
        env: params.env,
      }),
    );
    if (!manifest.ok) {
      return [];
    }
    return [
      {
        pluginId: manifest.manifest.id,
        origin: candidate.origin,
        packageName: candidate.packageName,
        workspaceDir: candidate.workspaceDir,
        rootDir: candidate.rootDir,
        channel,
        ...(candidate.packageManifest?.install
          ? { install: candidate.packageManifest.install }
          : {}),
      },
    ];
  });
}

function resolveInstallRecords(params: {
  origin?: PluginOrigin;
  env?: NodeJS.ProcessEnv;
  installRecords?: Record<string, PluginInstallRecord>;
}): Record<string, PluginInstallRecord> | undefined {
  if (params.installRecords) {
    return params.installRecords;
  }
  if (params.origin === "bundled") {
    return undefined;
  }
  try {
    return loadInstalledPluginIndexInstallRecordsSync(params.env ? { env: params.env } : {});
  } catch {
    return undefined;
  }
}
