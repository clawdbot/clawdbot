// Registers operator-configured task-lane providers onto the gateway service.
import path from "node:path";
import type { TaskLanesConfig } from "../../config/types.task-lanes.js";
import { createJsonFileProvider } from "../providers/json-file-provider.js";
import type { TaskLaneGatewayService } from "./service.js";

/**
 * Builds one JSON-file provider per configured entry. Id pattern and duplicate
 * ids are rejected by the config schema before startup, so the only failures
 * reaching addProvider are runtime revalidation of the same bounds.
 *
 * Relative rootDir values are operator config meaning "relative to the state
 * directory" (see schema help); they are anchored here so provider resolution
 * never depends on the gateway's process cwd.
 */
export function registerConfiguredTaskLaneProviders(
  service: TaskLaneGatewayService,
  config: TaskLanesConfig | undefined,
  opts?: { stateDir?: string },
): void {
  for (const provider of config?.providers ?? []) {
    const rootDir = path.isAbsolute(provider.rootDir)
      ? provider.rootDir
      : path.join(opts?.stateDir ?? "", provider.rootDir);
    service.addProvider(
      createJsonFileProvider(provider.id, {
        rootDir,
        filePath: provider.filePath,
      }),
    );
  }
}
