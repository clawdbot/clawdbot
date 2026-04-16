import {
  listBundledPluginMetadata,
  resolveBundledPluginGeneratedPath,
  resolveBundledPluginWorkspaceSourcePath,
  type BundledPluginMetadata,
} from "./bundled-plugin-metadata.js";

export type BundledChannelPluginMetadata = BundledPluginMetadata;

export function listBundledChannelPluginMetadata(params?: {
  rootDir?: string;
  scanDir?: string;
  includeChannelConfigs?: boolean;
  includeSyntheticChannelConfigs?: boolean;
}): readonly BundledChannelPluginMetadata[] {
  return listBundledPluginMetadata(params);
}

export function resolveBundledChannelGeneratedPath(
  rootDir: string,
  entry: BundledPluginMetadata["source"] | BundledPluginMetadata["setupSource"],
  pluginDirName?: string,
  scanDir?: string,
): string | null {
  return resolveBundledPluginGeneratedPath(rootDir, entry, pluginDirName, scanDir);
}

export function resolveBundledChannelWorkspacePath(params: {
  rootDir: string;
  scanDir?: string;
  pluginId: string;
}): string | null {
  return resolveBundledPluginWorkspaceSourcePath(params);
}
