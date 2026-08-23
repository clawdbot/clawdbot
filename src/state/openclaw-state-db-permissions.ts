import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createDedupeCache } from "../infra/dedupe.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";

const OPENCLAW_STATE_DIR_MODE = 0o700;
const OPENCLAW_STATE_FILE_MODE = 0o600;

const stateDbLog = createSubsystemLogger("state/db");

/** Targets already warned about, so chmod-less filesystems warn once per path. */
const chmodWarnedTargets = createDedupeCache({
  ttlMs: 0,
  maxSize: 4096,
});

// Permission hardening is best-effort only on filesystems that cannot apply
// it: the database stays usable without the chmod, and crashing at open would
// take the gateway down on Azure Files/NFS/Docker volumes (#91919). Unexpected
// chmod failures still throw so credentials-adjacent hardening stays loud.
function bestEffortChmodSync(target: string, mode: number): void {
  const result = applyPrivateModeSync(target, mode);
  if (result.applied || chmodWarnedTargets.check(target)) {
    return;
  }
  stateDbLog.warn(`skipped permission hardening for ${target}: ${String(result.error)}`);
}

export function ensureOpenClawStatePermissions(pathname: string, env: NodeJS.ProcessEnv): void {
  const dir = path.dirname(pathname);
  const defaultDir = resolveOpenClawStateSqliteDir(env);
  const isDefaultStateDatabase =
    path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));
  if (isDefaultStateDatabase && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
  }
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_STATE_DIR_MODE });
  // Default state contains credentials-adjacent metadata; custom existing dirs keep caller modes.
  if (isDefaultStateDatabase || !dirExisted) {
    bestEffortChmodSync(dir, OPENCLAW_STATE_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    if (existsSync(candidate)) {
      bestEffortChmodSync(candidate, OPENCLAW_STATE_FILE_MODE);
    }
  }
}
