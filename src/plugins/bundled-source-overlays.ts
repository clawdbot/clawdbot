import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { buildLegacyBundledRootPath } from "./bundled-load-path-aliases.js";

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseLinuxMountInfoMountPoints(mountInfo: string): Set<string> {
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

function readLinuxMountPoints(): Set<string> {
  try {
    return parseLinuxMountInfoMountPoints(fs.readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return new Set();
  }
}

function isFilesystemMountPoint(targetPath: string): boolean {
  try {
    const target = fs.statSync(targetPath);
    const parent = fs.statSync(path.dirname(targetPath));
    return target.dev !== parent.dev || target.ino === parent.ino;
  } catch {
    return false;
  }
}

function sourceOverlaysDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS);
  return raw === "1" || raw === "true";
}

export function isBundledSourceOverlayPath(params: {
  sourcePath: string;
  mountPoints?: ReadonlySet<string>;
}): boolean {
  const resolved = path.resolve(params.sourcePath);
  const mountPoints = params.mountPoints ?? readLinuxMountPoints();
  return mountPoints.has(resolved) || isFilesystemMountPoint(resolved);
}

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
  if (!legacyRoot || !fs.existsSync(legacyRoot)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
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
    if (!fs.existsSync(bundledPeer)) {
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
