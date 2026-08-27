import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "../config/plugin-install-record-map.js";
import { isSqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

export function inspectPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): PluginInstallRecordMapState {
  if (options.filePath?.endsWith(".json")) {
    return { status: "missing" };
  }
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        const hasTable = db
          .prepare(
            `SELECT 1
             FROM sqlite_master
            WHERE type = 'table' AND name = 'config_machine_state'`,
          )
          .get();
        if (!hasTable) {
          return { status: "missing" };
        }
        const row = db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          // SAFETY: config_machine_state.value_json is TEXT NOT NULL under STRICT.
          .get("plugins.installedIndex") as { value_json: string } | undefined;
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
      }, resolveInstalledPluginIndexStateDatabaseOptions(options)) ?? { status: "missing" }
    );
  } catch (error) {
    if (isSqliteSchemaVersionError(error)) {
      throw error;
    }
    return { status: "invalid" };
  }
}
