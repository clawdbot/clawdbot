import fs from "node:fs";
import path from "node:path";
import { resolveBundledPluginGeneratedPath } from "./bundled-plugin-metadata.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

type BundledChannelEntryPathPair = {
  source: string;
  built: string;
};

type BundledMetadataScope =
  | { kind: "default" }
  | { kind: "empty" }
  | { kind: "env"; env: NodeJS.ProcessEnv };

export type BundledChannelPluginMetadata = {
  dirName: string;
  source: BundledChannelEntryPathPair;
  setupSource?: BundledChannelEntryPathPair;
  manifest: {
    id: string;
    channels?: readonly string[];
  };
  packageManifest?: OpenClawPackageManifest;
  rootDir: string;
};

function resolveBundledMetadataScope(params?: {
  rootDir?: string;
  scanDir?: string;
}): BundledMetadataScope {
  const overrideDir = params?.scanDir
    ? path.resolve(params.scanDir)
    : params?.rootDir
      ? resolveBundledPluginsDirForRoot(params.rootDir)
      : undefined;
  if (!overrideDir) {
    return params?.rootDir ? { kind: "empty" } : { kind: "default" };
  }
  if (!fs.existsSync(overrideDir)) {
    return { kind: "empty" };
  }
  return {
    kind: "env",
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: overrideDir,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    },
  };
}

function resolveBundledPluginsDirForRoot(rootDir: string): string | undefined {
  const candidates = [
    path.join(rootDir, "extensions"),
    path.join(rootDir, "dist-runtime", "extensions"),
    path.join(rootDir, "dist", "extensions"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function toBundledChannelEntryPair(source: string | undefined): BundledChannelEntryPathPair | null {
  if (!source) {
    return null;
  }
  return { source, built: source };
}

function toBundledChannelPluginMetadata(
  record: PluginManifestRecord,
): BundledChannelPluginMetadata | null {
  if (record.origin !== "bundled") {
    return null;
  }
  const source = toBundledChannelEntryPair(record.source);
  if (!source) {
    return null;
  }
  const setupSource = toBundledChannelEntryPair(record.setupSource);
  return {
    dirName: path.basename(record.rootDir),
    source,
    ...(setupSource ? { setupSource } : {}),
    manifest: {
      id: record.id,
      channels: record.channels,
    },
    ...(record.packageManifest ? { packageManifest: record.packageManifest } : {}),
    rootDir: record.rootDir,
  };
}

export function listBundledChannelPluginMetadata(params?: {
  rootDir?: string;
  scanDir?: string;
  includeChannelConfigs?: boolean;
  includeSyntheticChannelConfigs?: boolean;
}): readonly BundledChannelPluginMetadata[] {
  const scope = resolveBundledMetadataScope(params);
  if (scope.kind === "empty") {
    return [];
  }
  return loadPluginManifestRegistryForPluginRegistry({
    env: scope.kind === "env" ? scope.env : undefined,
    includeDisabled: true,
  }).plugins.flatMap((record) => toBundledChannelPluginMetadata(record) ?? []);
}

export function resolveBundledChannelGeneratedPath(
  rootDir: string,
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"],
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
  return (
    listBundledChannelPluginMetadata({
      rootDir: params.rootDir,
      ...(params.scanDir ? { scanDir: params.scanDir } : {}),
      includeChannelConfigs: false,
      includeSyntheticChannelConfigs: false,
    }).find((metadata) => metadata.manifest.id === params.pluginId)?.rootDir ?? null
  );
}
