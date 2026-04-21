import { loadConfig } from "../config.js";
import type { SessionMaintenanceConfig } from "../types.base.js";
import {
  resolveMaintenanceConfigFromInput,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";

export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = loadConfig().session?.maintenance;
  } catch {
    // Config may not be available in narrow test/runtime helpers.
  }
  return resolveMaintenanceConfigFromInput(maintenance);
}
