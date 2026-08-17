import fs from "node:fs";
import { safeParseJson } from "@openclaw/normalization-core";
import {
  inspectPluginInstallRecordMap,
  type PluginInstallRecordMapState,
} from "../config/plugin-install-record-map.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
  type InstalledPluginIndexStoreOptions,
} from "./installed-plugin-index-store-path.js";

type InstalledPluginIndexRecordRow = {
  install_records_json: string;
};

export function inspectPersistedInstalledPluginIndexInstallRecordsSync(
  options: InstalledPluginIndexStoreOptions = {},
): PluginInstallRecordMapState {
  const storePath = resolveInstalledPluginIndexStorePath(options);
  if (!fs.existsSync(storePath) || options.filePath?.endsWith(".json")) {
    return { status: "missing" };
  }
  try {
    return withOpenClawStateDatabaseReadOnly(({ db }) => {
      const hasTable = db
        .prepare(
          `SELECT 1
             FROM sqlite_master
            WHERE type = 'table' AND name = 'installed_plugin_index'`,
        )
        .get();
      if (!hasTable) {
        return { status: "missing" };
      }
      const row = db
        .prepare(
          `
            SELECT install_records_json
              FROM installed_plugin_index
             WHERE index_key = ?
          `,
        )
        .get("installed-plugin-index") as InstalledPluginIndexRecordRow | undefined;
      if (!row) {
        return { status: "missing" };
      }
      const parsed = safeParseJson(row.install_records_json);
      return parsed === undefined ? { status: "invalid" } : inspectPluginInstallRecordMap(parsed);
    }, resolveInstalledPluginIndexStateDatabaseOptions(options));
  } catch {
    return { status: "invalid" };
  }
}
