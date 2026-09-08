// State-directory lookup without initializing process-wide config paths.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isFastTestRuntimeEnv } from "../infra/test-runtime-env.js";

const LEGACY_STATE_DIRNAMES = [".clawdbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}

export function resolveNewStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return path.join(homedir(), NEW_STATE_DIRNAME);
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.openclaw
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveHomeRelativePath(override, { env, homedir: effectiveHomedir });
  }
  return resolveStateDirFromHome(env, effectiveHomedir);
}

/** Select a default state directory from the caller's already resolved home. */
export function resolveStateDirFromHome(
  env: NodeJS.ProcessEnv,
  effectiveHomedir: () => string,
): string {
  const newDir = resolveNewStateDir(effectiveHomedir);
  if (isFastTestRuntimeEnv(env)) {
    return newDir;
  }
  const legacyDirs = resolveLegacyStateDirs(effectiveHomedir);
  const hasNew = fs.existsSync(newDir);
  if (hasNew) {
    return newDir;
  }
  const existingLegacy = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
  if (existingLegacy) {
    return existingLegacy;
  }
  return newDir;
}
