import fs from "node:fs";
import path from "node:path";

// Keep defaults to OS-managed immutable bins only.
// User/package-manager bins must be opted in via tools.exec.safeBinTrustedDirs.
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];

type TrustedSafeBinDirsParams = {
  baseDirs?: readonly string[];
  extraDirs?: readonly string[];
};

type TrustedSafeBinPathParams = {
  resolvedPath: string;
  trustedDirs?: ReadonlySet<string>;
};

type TrustedSafeBinCache = {
  key: string;
  dirs: Set<string>;
};

export type WritableTrustedSafeBinDir = {
  dir: string;
  groupWritable: boolean;
  worldWritable: boolean;
};

let trustedSafeBinCache: TrustedSafeBinCache | null = null;

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

function sameFsObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function pathCaseInsensitive(value: string): boolean {
  let candidate = value;
  for (;;) {
    const swapped = swapAsciiCase(candidate);
    if (swapped !== candidate) {
      try {
        const original = fs.statSync(candidate);
        try {
          const alternate = fs.statSync(swapped);
          return sameFsObject(original, alternate);
        } catch {
          return false;
        }
      } catch {
        // The compared path may not exist yet; probe the closest existing parent.
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return process.platform === "win32";
    }
    candidate = parent;
  }
}

function normalizeTrustComparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return pathCaseInsensitive(resolved) ? resolved.toLowerCase() : resolved;
}

function normalizeTrustedDir(value: string, forComparison = true): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return forComparison ? normalizeTrustComparisonPath(trimmed) : path.resolve(trimmed);
}

export function normalizeTrustedSafeBinDirs(entries?: readonly string[] | null): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized = entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Array.from(new Set(normalized));
}

function resolveTrustedSafeBinDirs(entries: readonly string[], forComparison = true): string[] {
  const resolved = entries
    .map((entry) => normalizeTrustedDir(entry, forComparison))
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(resolved)).toSorted();
}

function buildTrustedSafeBinCacheKey(entries: readonly string[]): string {
  return resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries)).join("\u0001");
}

export function buildTrustedSafeBinDirs(params: TrustedSafeBinDirsParams = {}): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  // Trust is explicit only. Do not derive from PATH, which is user/environment controlled.
  return new Set(
    resolveTrustedSafeBinDirs([
      ...normalizeTrustedSafeBinDirs(baseDirs),
      ...normalizeTrustedSafeBinDirs(extraDirs),
    ]),
  );
}

export function getTrustedSafeBinDirs(
  params: {
    baseDirs?: readonly string[];
    extraDirs?: readonly string[];
    refresh?: boolean;
  } = {},
): Set<string> {
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const extraDirs = params.extraDirs ?? [];
  const key = buildTrustedSafeBinCacheKey([...baseDirs, ...extraDirs]);

  if (!params.refresh && trustedSafeBinCache?.key === key) {
    return trustedSafeBinCache.dirs;
  }

  const dirs = buildTrustedSafeBinDirs({
    baseDirs,
    extraDirs,
  });
  trustedSafeBinCache = { key, dirs };
  return dirs;
}

export function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): boolean {
  const trustedDirs = params.trustedDirs ?? getTrustedSafeBinDirs();
  const resolvedDir = normalizeTrustComparisonPath(path.dirname(path.resolve(params.resolvedPath)));
  return trustedDirs.has(resolvedDir);
}

export function listWritableExplicitTrustedSafeBinDirs(
  entries?: readonly string[] | null,
): WritableTrustedSafeBinDir[] {
  if (process.platform === "win32") {
    return [];
  }
  const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries), false);
  const hits: WritableTrustedSafeBinDir[] = [];
  for (const dir of resolved) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const mode = stat.mode & 0o777;
    const groupWritable = (mode & 0o020) !== 0;
    const worldWritable = (mode & 0o002) !== 0;
    if (!groupWritable && !worldWritable) {
      continue;
    }
    hits.push({ dir, groupWritable, worldWritable });
  }
  return hits;
}
