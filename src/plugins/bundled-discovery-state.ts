// Bundled-discovery compatibility is machine-owned upgrade state.
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";

export function readBundledDiscoveryMode(
  options: OpenClawStateDatabaseOptions = {},
): "compat" | "allowlist" | undefined {
  const resolvedOptions =
    options.path || options.database || !hasActivePluginInstallRoots()
      ? options
      : {
          ...options,
          env: {
            ...(options.env ?? process.env),
            OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(options.env).stateDir,
          },
        };
  const value = readConfigMachineState<unknown>("plugins.bundledDiscovery", resolvedOptions);
  return value === "compat" || value === "allowlist" ? value : undefined;
}

// Single-slot process memo keyed by the resolved state-database path: the mode
// is machine-owned upgrade state that only changes through doctor/restart, and
// per-plugin activation must not open SQLite once per decision. The key keeps
// interleaved isolated scopes (agent execution, doctor lint) from inheriting
// another root's cached mode; the reads honor the active install-root context.
let memoizedBundledDiscoveryMode:
  | { key: string; value: "compat" | "allowlist" | undefined }
  | undefined;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  memoizedBundledDiscoveryMode = undefined;
});

function resolveBundledDiscoveryMemoKey(env: NodeJS.ProcessEnv): string {
  const scopedEnv = hasActivePluginInstallRoots()
    ? { ...env, OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(env).stateDir }
    : env;
  return resolveOpenClawStateSqlitePath(scopedEnv);
}

/**
 * Callers loading a registry with an explicit env pass it so the mode comes
 * from that env's state root; omitting it reads the process root. Pinned
 * install roots win over both, matching readBundledDiscoveryMode.
 */
export function readBundledDiscoveryModeMemoized(
  env: NodeJS.ProcessEnv = process.env,
): "compat" | "allowlist" | undefined {
  const key = resolveBundledDiscoveryMemoKey(env);
  if (memoizedBundledDiscoveryMode?.key !== key) {
    memoizedBundledDiscoveryMode = {
      key,
      value: readBundledDiscoveryMode(env === process.env ? {} : { env }),
    };
  }
  return memoizedBundledDiscoveryMode.value;
}

/**
 * Clears the memo after a machine-state write so same-process readers observe
 * the new mode. Without this, doctor's migration could cache the pre-migration
 * absent mode and rebuild plugin indexes against stale strict-gate decisions.
 */
export function clearBundledDiscoveryModeMemo(): void {
  memoizedBundledDiscoveryMode = undefined;
}
