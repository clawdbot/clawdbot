// Cron store selection preserves the retired configured partition through shared SQLite state.
import { readConfigMachineState } from "../../state/config-machine-state.js";

export function readCronStoreStatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = readConfigMachineState<unknown>("cron.store", { env });
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
