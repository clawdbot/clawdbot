import fs from "node:fs";
import path from "node:path";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  getPackageManifestMetadata,
  type PackageManifest,
  type PluginPackageChannel,
} from "./manifest.js";

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf-8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

export function listBundledPackageChannelMetadata(): readonly PluginPackageChannel[] {
  const scanDir = resolveBundledPluginsDir();
  if (!scanDir || !fs.existsSync(scanDir)) {
    return [];
  }
  return fs
    .readdirSync(scanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readPackageManifest(path.join(scanDir, entry.name)))
    .map((manifest) => getPackageManifestMetadata(manifest)?.channel)
    .filter((channel): channel is PluginPackageChannel => Boolean(channel?.id));
}

export function findBundledPackageChannelMetadata(
  channelId: string,
): PluginPackageChannel | undefined {
  return listBundledPackageChannelMetadata().find(
    (channel) => channel.id === channelId || channel.aliases?.includes(channelId),
  );
}
