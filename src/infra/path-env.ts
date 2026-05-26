import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "../shared/string-normalization.js";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";

type EnsureOpenClawPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
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
  const cwd = opts.cwd ?? process.cwd();
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
  if (allowProjectLocalBin) {
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
  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  const miseShims = path.join(miseDataDir, "shims");
  if (isKnownPathDir(existingPathParts, miseShims)) {
    append.push(miseShims);
  }
  if (platform === "darwin") {
    append.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (process.env.XDG_BIN_HOME) {
    append.push(process.env.XDG_BIN_HOME);
  }
  append.push(path.join(homeDir, ".local", "bin"));
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
