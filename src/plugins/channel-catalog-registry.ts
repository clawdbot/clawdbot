import { discoverOpenClawPlugins } from "./discovery.js";
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
  } = {},
): PluginChannelCatalogEntry[] {
  return discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
  }).candidates.flatMap((candidate) => {
    if (params.origin && candidate.origin !== params.origin) {
      return [];
    }
    const channel = candidate.packageManifest?.channel;
    if (!channel?.id) {
      return [];
    }
    const manifest = loadPluginManifest(candidate.rootDir, candidate.origin !== "bundled");
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
