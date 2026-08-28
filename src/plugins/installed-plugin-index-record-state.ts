import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "../config/plugin-install-record-map.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-row.js";
import type { InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";

export function inspectPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): PluginInstallRecordMapState {
  const row = readPersistedInstalledPluginIndexRowSync(options);
  if (!row) {
    return { status: "missing" };
  }
  const value = safeParseJson(row.value_json) as
    | { index?: { installRecords?: unknown } }
    | undefined;
  const installRecords = value?.index?.installRecords;
  return installRecords === undefined
    ? { status: "invalid" }
    : inspectPluginInstallRecordMap(installRecords);
}
