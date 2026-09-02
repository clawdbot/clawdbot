// Resolves bundled source overlays used by plugin packaging.
import fs from "node:fs";
import path from "node:path";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { buildLegacyBundledRootPath } from "./bundled-load-path-aliases.js";
import {
  pluginCacheExistsSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
} from "./plugin-cache-files.js";
import { getPluginCache } from "./plugin-cache.js";

/** Parses Linux mountinfo content into absolute mount points. */
function parseLinuxMountInfoMountPoints(mountInfo: string): Set<string> {
  const mountPoints = new Set<string>();
  for (const line of mountInfo.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const fields = trimmed.split(" ");
    const mountPoint = fields[4];
    if (!mountPoint) {
      continue;
    }
    mountPoints.add(path.resolve(decodeMountInfoPath(mountPoint)));
  }
  return mountPoints;
}

function readLinuxMountPoints(): ReadonlySet<string> {
  const metadata = getPluginCache().metadata;
  if (!metadata.discoveryMountPoints) {
    try {
      metadata.discoveryMountPoints = parseLinuxMountInfoMountPoints(
        fs.readFileSync("/proc/self/mountinfo", "utf8"),
      );
    } catch {
      metadata.discoveryMountPoints = new Set();
    }
  }
  return metadata.discoveryMountPoints;
}

function isFilesystemMountPoint(targetPath: string): boolean {
  const target = pluginCacheStatSync(targetPath);
  const parent = pluginCacheStatSync(path.dirname(targetPath));
  return Boolean(target && parent && (target.dev !== parent.dev || target.ino === parent.ino));
}

function sourceOverlaysDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS);
  return raw === "1" || raw === "true";
}

/** True when a path appears to be a mounted bundled source overlay. */
export function isBundledSourceOverlayPath(params: {
  sourcePath: string;
  mountPoints?: ReadonlySet<string>;
}): boolean {
  const resolved = path.resolve(params.sourcePath);
  const mountPoints = params.mountPoints ?? readLinuxMountPoints();
  return mountPoints.has(resolved) || isFilesystemMountPoint(resolved);
}

/** Lists source overlay directories that shadow packaged bundled plugin dirs. */
export function listBundledSourceOverlayDirs(params: {
  bundledRoot?: string;
  env?: NodeJS.ProcessEnv;
  mountPoints?: ReadonlySet<string>;
}): string[] {
  const env = params.env ?? process.env;
  if (sourceOverlaysDisabled(env) || !params.bundledRoot) {
    return [];
  }
  const legacyRoot = buildLegacyBundledRootPath(params.bundledRoot);
  if (!legacyRoot || !pluginCacheExistsSync(legacyRoot)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = readPluginCacheDirectory(legacyRoot);
  } catch {
    return [];
  }

  const mountPoints = params.mountPoints ?? readLinuxMountPoints();
  const legacyRootMounted = isBundledSourceOverlayPath({
    sourcePath: legacyRoot,
    mountPoints,
  });
  const overlayDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(legacyRoot, entry.name);
    const bundledPeer = path.join(params.bundledRoot, entry.name);
    if (!pluginCacheExistsSync(bundledPeer)) {
      continue;
    }
    if (
      !legacyRootMounted &&
      !isBundledSourceOverlayPath({
        sourcePath: sourceDir,
        mountPoints,
      })
    ) {
      continue;
    }
    overlayDirs.push(sourceDir);
  }
  return overlayDirs.toSorted((left, right) => left.localeCompare(right));
}
