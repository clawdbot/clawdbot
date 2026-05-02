import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectBundledChannelConfigs } from "./bundled-channel-config-metadata.js";
import {
  collectBundledPluginPublicSurfaceArtifacts,
  collectBundledPluginRuntimeSidecarArtifacts,
  deriveBundledPluginIdHint,
  normalizeBundledPluginStringList,
  rewriteBundledPluginEntryToBuiltPath,
  resolveBundledPluginScanDir,
  trimBundledPluginString,
} from "./bundled-plugin-scan.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type OpenClawPackageManifest,
  type PackageManifest,
  type PluginManifest,
} from "./manifest.js";
import { resolveLoaderPackageRoot } from "./sdk-alias.js";

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type BundledPluginPathPair = {
  source: string;
  built: string;
};

export type BundledPluginMetadata = {
  dirName: string;
  idHint: string;
  source: BundledPluginPathPair;
  setupSource?: BundledPluginPathPair;
  publicSurfaceArtifacts?: readonly string[];
  runtimeSidecarArtifacts?: readonly string[];
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageManifest?: OpenClawPackageManifest;
  manifest: PluginManifest;
};

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

function resolveBundledPluginMetadataScanDir(
  packageRoot: string,
  scanDir?: string,
): string | undefined {
  if (scanDir) {
    return path.resolve(scanDir);
  }
  return resolveBundledPluginScanDir({
    packageRoot,
    runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT,
  });
}

function resolveBundledPluginLookupParams(params: { rootDir: string; scanDir?: string }): {
  rootDir: string;
  scanDir?: string;
} {
  return params.scanDir ? params : { rootDir: params.rootDir };
}

function collectBundledPluginMetadata(
  resolvedScanDir: string | undefined,
  includeChannelConfigs: boolean,
  includeSyntheticChannelConfigs: boolean,
): readonly BundledPluginMetadata[] {
  if (!resolvedScanDir || !fs.existsSync(resolvedScanDir)) {
    return [];
  }

  const entries: BundledPluginMetadata[] = [];
  for (const dirName of fs
    .readdirSync(resolvedScanDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right))) {
    const pluginDir = path.join(resolvedScanDir, dirName);
    const manifestResult = loadPluginManifest(pluginDir, false);
    if (!manifestResult.ok) {
      continue;
    }

    const packageJson = readPackageManifest(pluginDir);
    const packageManifest = getPackageManifestMetadata(packageJson);
    const extensions = normalizeBundledPluginStringList(packageManifest?.extensions);
    if (extensions.length === 0) {
      continue;
    }
    const sourceEntry = trimBundledPluginString(extensions[0]);
    const builtEntry = rewriteBundledPluginEntryToBuiltPath(sourceEntry);
    if (!sourceEntry || !builtEntry) {
      continue;
    }

    const setupSourcePath = trimBundledPluginString(packageManifest?.setupEntry);
    const setupSource =
      setupSourcePath && rewriteBundledPluginEntryToBuiltPath(setupSourcePath)
        ? {
            source: setupSourcePath,
            built: rewriteBundledPluginEntryToBuiltPath(setupSourcePath)!,
          }
        : undefined;
    const publicSurfaceArtifacts = collectBundledPluginPublicSurfaceArtifacts({
      pluginDir,
      sourceEntry,
      ...(setupSourcePath ? { setupEntry: setupSourcePath } : {}),
    });
    const runtimeSidecarArtifacts =
      collectBundledPluginRuntimeSidecarArtifacts(publicSurfaceArtifacts);
    const channelConfigs =
      includeChannelConfigs && includeSyntheticChannelConfigs
        ? collectBundledChannelConfigs({
            pluginDir,
            manifest: manifestResult.manifest,
            packageManifest,
          })
        : manifestResult.manifest.channelConfigs;

    entries.push({
      dirName,
      idHint: deriveBundledPluginIdHint({
        entryPath: sourceEntry,
        manifestId: manifestResult.manifest.id,
        packageName: trimBundledPluginString(packageJson?.name),
        hasMultipleExtensions: extensions.length > 1,
      }),
      source: {
        source: sourceEntry,
        built: builtEntry,
      },
      ...(setupSource ? { setupSource } : {}),
      ...(publicSurfaceArtifacts ? { publicSurfaceArtifacts } : {}),
      ...(runtimeSidecarArtifacts ? { runtimeSidecarArtifacts } : {}),
      ...(trimBundledPluginString(packageJson?.name)
        ? { packageName: trimBundledPluginString(packageJson?.name) }
        : {}),
      ...(trimBundledPluginString(packageJson?.version)
        ? { packageVersion: trimBundledPluginString(packageJson?.version) }
        : {}),
      ...(trimBundledPluginString(packageJson?.description)
        ? { packageDescription: trimBundledPluginString(packageJson?.description) }
        : {}),
      ...(packageManifest ? { packageManifest } : {}),
      manifest: {
        ...manifestResult.manifest,
        ...(channelConfigs ? { channelConfigs } : {}),
      },
    });
  }

  return entries;
}

export function listBundledPluginMetadata(params?: {
  rootDir?: string;
  scanDir?: string;
  includeChannelConfigs?: boolean;
  includeSyntheticChannelConfigs?: boolean;
}): readonly BundledPluginMetadata[] {
  const rootDir = path.resolve(params?.rootDir ?? OPENCLAW_PACKAGE_ROOT);
  const scanDir = params?.scanDir ? path.resolve(params.scanDir) : undefined;
  const resolvedScanDir = resolveBundledPluginMetadataScanDir(rootDir, scanDir);
  const includeChannelConfigs = params?.includeChannelConfigs ?? !RUNNING_FROM_BUILT_ARTIFACT;
  const includeSyntheticChannelConfigs =
    params?.includeSyntheticChannelConfigs ?? includeChannelConfigs;
  const metadata = Object.freeze(
    collectBundledPluginMetadata(
      resolvedScanDir,
      includeChannelConfigs,
      includeSyntheticChannelConfigs,
    ),
  );
  return metadata;
}

export function findBundledPluginMetadataById(
  pluginId: string,
  params?: {
    rootDir?: string;
    scanDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
  },
): BundledPluginMetadata | undefined {
  return listBundledPluginMetadata(params).find((entry) => entry.manifest.id === pluginId);
}

export function resolveBundledPluginWorkspaceSourcePath(params: {
  rootDir: string;
  scanDir?: string;
  pluginId: string;
}): string | null {
  const metadata = findBundledPluginMetadataById(params.pluginId, {
    ...resolveBundledPluginLookupParams({
      rootDir: params.rootDir,
      scanDir: params.scanDir,
    }),
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  });
  if (!metadata) {
    return null;
  }
  if (params.scanDir) {
    return path.resolve(params.scanDir, metadata.dirName);
  }
  return path.resolve(params.rootDir, "extensions", metadata.dirName);
}

function listBundledPluginEntryBaseDirs(params: {
  rootDir: string;
  pluginDirName?: string;
  scanDir?: string;
}): string[] {
  const baseDirs = [
    ...(params.scanDir ? [path.resolve(params.scanDir, params.pluginDirName ?? "")] : []),
    path.resolve(params.rootDir, "dist", "extensions", params.pluginDirName ?? ""),
    path.resolve(params.rootDir, "extensions", params.pluginDirName ?? ""),
  ];
  return baseDirs.filter((entry, index, all) => all.indexOf(entry) === index);
}

export function resolveBundledPluginGeneratedPath(
  rootDir: string,
  entry: BundledPluginPathPair | undefined,
  pluginDirName?: string,
  scanDir?: string,
): string | null {
  if (!entry) {
    return null;
  }
  const entryOrder = [entry.built, entry.source].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const baseDirs = listBundledPluginEntryBaseDirs({
    rootDir,
    pluginDirName,
    ...(scanDir ? { scanDir } : {}),
  });
  for (const baseDir of baseDirs) {
    for (const entryPath of entryOrder) {
      const candidate = path.resolve(baseDir, normalizeRelativePluginEntryPath(entryPath));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function normalizeRelativePluginEntryPath(entryPath: string): string {
  return entryPath.replace(/^\.\//u, "");
}

export function resolveBundledPluginRepoEntryPath(params: {
  rootDir: string;
  pluginId: string;
  preferBuilt?: boolean;
  scanDir?: string;
}): string | null {
  const metadata = findBundledPluginMetadataById(params.pluginId, {
    ...resolveBundledPluginLookupParams({
      rootDir: params.rootDir,
      scanDir: params.scanDir,
    }),
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  });
  if (!metadata) {
    return null;
  }

  const entryOrder = params.preferBuilt
    ? [metadata.source.built, metadata.source.source]
    : [metadata.source.source, metadata.source.built];
  const baseDirs = listBundledPluginEntryBaseDirs({
    rootDir: params.rootDir,
    pluginDirName: metadata.dirName,
    ...(params.scanDir ? { scanDir: params.scanDir } : {}),
  });

  for (const baseDir of baseDirs) {
    for (const entryPath of entryOrder) {
      const candidate = path.resolve(baseDir, normalizeRelativePluginEntryPath(entryPath));
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
