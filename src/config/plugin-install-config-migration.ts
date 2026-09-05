// Validates retired plugin install config before Doctor migrates its records.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "./plugin-install-record-map.js";

export function inspectShippedPluginInstallConfigRecords(
  config: unknown,
): PluginInstallRecordMapState {
  if (!isRecord(config) || !isRecord(config.plugins)) {
    return { status: "missing" };
  }
  return inspectPluginInstallRecordMap(config.plugins.installs);
}
