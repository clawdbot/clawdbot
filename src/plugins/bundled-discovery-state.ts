// Bundled-discovery compatibility is machine-owned upgrade state.
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";

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
