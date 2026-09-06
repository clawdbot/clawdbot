import path from "node:path";
import { resolveConfigPath } from "../config/paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { ClawMonitorCleanupBinding } from "./monitor-cleanup-contract.js";

/** Claw files remain local; the serving monitor owner must use that same state and config. */
export function resolveClawMonitorCleanupBinding(cronStorePath: string): ClawMonitorCleanupBinding {
  return {
    configPath: path.resolve(resolveConfigPath()),
    statePath: path.resolve(resolveOpenClawStateSqlitePath()),
    cronStorePath: path.resolve(cronStorePath),
  };
}
