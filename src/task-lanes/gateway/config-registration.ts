// Registers operator-configured task-lane providers onto the gateway service.
import type { TaskLanesConfig } from "../../config/types.task-lanes.js";
import { createJsonFileProvider } from "../providers/json-file-provider.js";
import type { TaskLaneGatewayService } from "./service.js";

/**
 * Builds one JSON-file provider per configured entry. Id pattern and duplicate
 * ids are rejected by the config schema before startup, so the only failures
 * reaching addProvider are runtime revalidation of the same bounds.
 */
export function registerConfiguredTaskLaneProviders(
  service: TaskLaneGatewayService,
  config: TaskLanesConfig | undefined,
): void {
  for (const provider of config?.providers ?? []) {
    service.addProvider(
      createJsonFileProvider(provider.id, {
        rootDir: provider.rootDir,
        filePath: provider.filePath,
      }),
    );
  }
}
