import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTruthyEnvValue } from "./env.js";

import { resolveBrewPathDirs } from "./brew.js";

type EnsureMoltbotPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
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

function mergePath(params: { existing: string; prepend: string[] }): string {
  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const partsPrepend = params.prepend.map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...partsPrepend, ...partsExisting]) {
    if (!seen.has(part)) {
      seen.add(part);
      merged.push(part);
    }
  }
  return merged.join(path.delimiter);
}

function candidateBinDirs(opts: EnsureMoltbotPathOpts): string[] {
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;

  const candidates: string[] = [];

  // Bundled macOS app: `moltbot` lives next to the executable (process.execPath).
  try {
    const execDir = path.dirname(execPath);
    const siblingMoltbot = path.join(execDir, "moltbot");
    if (isExecutable(siblingMoltbot)) candidates.push(execDir);
  } catch {
    // ignore
  }

  // Project-local installs (best effort): if a `node_modules/.bin/moltbot` exists near cwd,
  // include it. This helps when running under launchd or other minimal PATH environments.
  const localBinDir = path.join(cwd, "node_modules", ".bin");
  if (isExecutable(path.join(localBinDir, "moltbot"))) candidates.push(localBinDir);

  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims)) candidates.push(miseShims);

  candidates.push(...resolveBrewPathDirs({ homeDir }));

  // Common global install locations (macOS first).
  if (platform === "darwin") {
    candidates.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (process.env.XDG_BIN_HOME) candidates.push(process.env.XDG_BIN_HOME);
  candidates.push(path.join(homeDir, ".local", "bin"));
  candidates.push(path.join(homeDir, ".local", "share", "pnpm"));
  candidates.push(path.join(homeDir, ".bun", "bin"));
  candidates.push(path.join(homeDir, ".yarn", "bin"));
  candidates.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");

  return candidates.filter(isDirectory);
}

/**
 * Best-effort PATH bootstrap so skills that require the `moltbot` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
export function ensureMoltbotCliOnPath(opts: EnsureMoltbotPathOpts = {}) {
  if (isTruthyEnvValue(process.env.CLAWDBOT_PATH_BOOTSTRAPPED)) return;
  process.env.CLAWDBOT_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  const prepend = candidateBinDirs(opts);
  if (prepend.length === 0) return;

  const merged = mergePath({ existing, prepend });
  if (merged) process.env.PATH = merged;
}
