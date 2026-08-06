// Builds PATH values for OpenClaw child processes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";
import { tryProcessCwd } from "./safe-cwd.js";

type EnsureOpenClawPathOpts = {
  /** Executable whose directory should stay first for shebang-compatible child processes. */
  execPath?: string;
  /** Working directory used only when project-local bin fallback is explicitly enabled. */
  cwd?: string;
  /** Home directory used for package-manager and user-bin fallback candidates. */
  homeDir?: string;
  /** Platform override for tests and platform-specific candidate filtering. */
  platform?: NodeJS.Platform;
  /** Existing PATH value to merge with; defaults to process.env.PATH. */
  pathEnv?: string;
  /** Opt-in to append cwd/node_modules/.bin after trusted system paths. */
  allowProjectLocalBin?: boolean;
};

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function splitPathParts(pathEnv: string): Set<string> {
  return new Set(normalizeStringEntries(pathEnv.split(path.delimiter)));
}

function isKnownPathDir(existingPathParts: ReadonlySet<string>, dirPath: string): boolean {
  return existingPathParts.has(dirPath) || isDirectory(dirPath);
}

function realpathExistingPath(candidate: string): string | undefined {
  const suffix: string[] = [];
  let current = candidate;
  while (true) {
    try {
      return path.resolve(fs.realpathSync.native(current), ...suffix.toReversed());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isFilesystemRoot(dirPath: string): boolean {
  return path.dirname(dirPath) === dirPath;
}

function normalizeTrustedPackageManagerRoot(params: {
  value: string | undefined;
  cwd: string | undefined;
  homeDir: string;
}): string | undefined {
  const trimmed = params.value?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  const normalized = path.normalize(trimmed);
  if (normalized === "/proc" || normalized.startsWith(`/proc${path.sep}`)) {
    return undefined;
  }
  if (!params.cwd) {
    return normalized;
  }

  const cwd = path.resolve(params.cwd);
  const homeDir = path.resolve(params.homeDir);
  if (cwd === homeDir || isFilesystemRoot(cwd)) {
    return normalized;
  }
  if (isSameOrChildPath(normalized, cwd)) {
    return undefined;
  }

  const realCandidate = realpathExistingPath(normalized);
  const realCwd = realpathExistingPath(cwd);
  const realHome = realpathExistingPath(homeDir);
  if (
    realCwd &&
    realCwd !== realHome &&
    !isFilesystemRoot(realCwd) &&
    realCandidate &&
    isSameOrChildPath(realCandidate, realCwd)
  ) {
    return undefined;
  }
  return normalized;
}

function isLinuxbrewPath(dirPath: string): boolean {
  return dirPath.split(path.sep).includes(".linuxbrew");
}

function resolvePathBootstrapBrewDirs(params: {
  homeDir: string;
  platform: NodeJS.Platform;
  existingPathParts: ReadonlySet<string>;
}): string[] {
  const candidates = resolveBrewPathDirs({ homeDir: params.homeDir });
  if (params.platform !== "darwin") {
    return candidates;
  }
  return candidates.filter(
    (candidate) => !isLinuxbrewPath(candidate) || params.existingPathParts.has(candidate),
  );
}

function resolveMiseDataDir(params: { homeDir: string; platform: NodeJS.Platform }): string {
  const miseDataDir = process.env.MISE_DATA_DIR;
  if (miseDataDir !== undefined) {
    return miseDataDir;
  }

  // Match mise's override/XDG/platform order; candidate validation and PATH
  // placement remain owned by the existing bootstrap policy below.
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome !== undefined) {
    return path.join(xdgDataHome, "mise");
  }
  if (params.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(params.homeDir, "AppData", "Local");
    return path.join(localAppData, "mise");
  }
  return path.join(params.homeDir, ".local", "share", "mise");
}

function mergePath(params: { existing: string; prepend?: string[]; append?: string[] }): string {
  return normalizeUniqueStringEntries([
    ...(params.prepend ?? []),
    ...params.existing.split(path.delimiter),
    ...(params.append ?? []),
  ]).join(path.delimiter);
}

function candidateBinDirs(
  opts: EnsureOpenClawPathOpts,
  existingPathParts: ReadonlySet<string>,
): { prepend: string[]; append: string[] } {
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? tryProcessCwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;

  const prepend: string[] = [];
  const append: string[] = [];

  // Keep the active runtime directory ahead of PATH hardening so shebang-based
  // subprocesses keep using the same Node/Bun the current OpenClaw process is on.
  try {
    const execDir = path.dirname(execPath);
    if (isExecutable(execPath)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  try {
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "openclaw");
    if (isExecutable(siblingCli)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Project-local installs are a common repo-based attack vector (bin hijacking). Keep this
  // disabled by default; if an operator explicitly enables it, only append (never prepend).
  const allowProjectLocalBin =
    opts.allowProjectLocalBin === true ||
    isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN);
  if (allowProjectLocalBin && cwd) {
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (isExecutable(path.join(localBinDir, "openclaw"))) {
      append.push(localBinDir);
    }
  }

  // Only immutable OS directories go in prepend so they take priority over
  // user-writable locations, preventing PATH hijack of system binaries.
  prepend.push("/usr/bin", "/bin");

  // User-writable / package-manager directories are appended so they never
  // shadow trusted OS binaries.
  // This includes Brew/Homebrew dirs, which are useful for finding `openclaw`
  // in launchd/minimal environments but must not be treated as trusted.
  append.push(...resolvePathBootstrapBrewDirs({ homeDir, platform, existingPathParts }));
  const pnpmHome = normalizeTrustedPackageManagerRoot({
    value: process.env.PNPM_HOME,
    cwd,
    homeDir,
  });
  if (pnpmHome) {
    append.push(pnpmHome);
    append.push(path.join(pnpmHome, "bin"));
  }
  const npmPrefix = normalizeTrustedPackageManagerRoot({
    value: process.env.NPM_CONFIG_PREFIX,
    cwd,
    homeDir,
  });
  if (npmPrefix) {
    append.push(path.join(npmPrefix, "bin"));
  }
  const miseDataDir = resolveMiseDataDir({ homeDir, platform });
  const miseShims = path.join(miseDataDir, "shims");
  if (isKnownPathDir(existingPathParts, miseShims)) {
    append.push(miseShims);
  }
  if (platform === "darwin") {
    append.push(path.join(homeDir, "Library", "pnpm", "bin"));
    append.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (process.env.XDG_BIN_HOME) {
    append.push(process.env.XDG_BIN_HOME);
  }
  append.push(path.join(homeDir, ".local", "bin"));
  append.push(path.join(homeDir, ".npm-global", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm"));
  append.push(path.join(homeDir, ".bun", "bin"));
  append.push(path.join(homeDir, ".yarn", "bin"));

  return {
    prepend: prepend.filter((candidate) => isKnownPathDir(existingPathParts, candidate)),
    append: append.filter((candidate) => isKnownPathDir(existingPathParts, candidate)),
  };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
export function ensureOpenClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) {
    return;
  }
  // Mark before filesystem probing so repeated calls from nested bootstraps do
  // not keep reshuffling PATH.
  process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  const existingPathParts = splitPathParts(existing);
  const { prepend, append } = candidateBinDirs(opts, existingPathParts);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }

  const merged = mergePath({ existing, prepend, append });
  if (merged) {
    process.env.PATH = merged;
  }
}
