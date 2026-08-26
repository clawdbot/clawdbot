import type { DatabaseSync } from "node:sqlite";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { repairLegacySubagentRetainedResults } from "./openclaw-state-db-legacy-backfills.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const FAILURE_DESTINATION_COLUMNS = [
  ["failure_delivery_mode", "mode"],
  ["failure_delivery_channel", "channel"],
  ["failure_delivery_to", "to"],
  ["failure_delivery_account_id", "accountId"],
] as const;

function reprojectLegacyCronJson(db: DatabaseSync): void {
  const projectionColumns = FAILURE_DESTINATION_COLUMNS.map(([columnName]) =>
    tableHasColumn(db, "cron_jobs", columnName)
      ? quoteSqliteIdentifier(columnName)
      : `NULL AS ${quoteSqliteIdentifier(columnName)}`,
  );
  const lastRunStatus = tableHasColumn(db, "cron_jobs", "last_run_status")
    ? "last_run_status"
    : "NULL AS last_run_status";
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, state_json, ${lastRunStatus}, ${projectionColumns.join(", ")}
         FROM cron_jobs`,
    )
    .all();
  const update = db.prepare(
    "UPDATE cron_jobs SET job_json = ?, state_json = ? WHERE store_key = ? AND job_id = ?",
  );

  for (const row of rows) {
    if (
      typeof row.store_key !== "string" ||
      typeof row.job_id !== "string" ||
      typeof row.job_json !== "string" ||
      typeof row.state_json !== "string"
    ) {
      throw new Error("OpenClaw v12 cron job row is not canonical");
    }
    const job = asNullableRecord(JSON.parse(row.job_json));
    const state = asNullableRecord(JSON.parse(row.state_json));
    if (!job || !state) {
      throw new Error("OpenClaw v12 cron job JSON is not canonical");
    }
    let changed = false;
    for (const [columnName, fieldName] of FAILURE_DESTINATION_COLUMNS) {
      const value = row[columnName];
      if (typeof value !== "string") {
        continue;
      }
      const delivery = asNullableRecord(job.delivery) ?? {};
      const destination = asNullableRecord(delivery.failureDestination) ?? {};
      destination[fieldName] = value === "" ? null : value;
      delivery.failureDestination = destination;
      job.delivery = delivery;
      changed = true;
    }
    const normalizedLastRunStatus = row.last_run_status ?? state.lastRunStatus ?? state.lastStatus;
    if (normalizedLastRunStatus != null && state.lastRunStatus !== normalizedLastRunStatus) {
      state.lastRunStatus = normalizedLastRunStatus;
      changed = true;
    }
    if (changed) {
      update.run(JSON.stringify(job), JSON.stringify(state), row.store_key, row.job_id);
    }
  }
}

function rebuildJsonCanonicalTable(db: DatabaseSync, tableName: string): void {
  const migrationTable = `${tableName}_migration_v13`;
  if (tableExists(db, migrationTable)) {
    throw new Error(`OpenClaw v13 migration table already exists: ${migrationTable}`);
  }
  const startMarker = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(startMarker);
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error(`Canonical ${tableName} schema block is missing`);
  }
  const migrationSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length).replace(
    startMarker,
    `CREATE TABLE ${migrationTable} (`,
  );
  db.exec(migrationSchema);
  const columns = db
    .prepare(`PRAGMA table_xinfo(${migrationTable})`)
    .all()
    .flatMap((column) =>
      column.hidden === 0 && typeof column.name === "string"
        ? [quoteSqliteIdentifier(column.name)]
        : [],
    )
    .join(", ");
  db.exec(`INSERT INTO ${migrationTable} (${columns}) SELECT ${columns} FROM ${tableName};`);
  db.exec(`DROP TABLE ${tableName};`);
  db.exec(`ALTER TABLE ${migrationTable} RENAME TO ${tableName};`);
}

/** Fold obsolete physical projections into canonical JSON before removing their columns. */
export function migrateJsonCanonicalWideRowsV13(
  db: DatabaseSync,
  previousVersion: number,
): boolean {
  if (previousVersion >= 13) {
    return false;
  }
  let migrated = false;
  if (tableExists(db, "cron_jobs") && tableHasColumn(db, "cron_jobs", "schedule_kind")) {
    reprojectLegacyCronJson(db);
    rebuildJsonCanonicalTable(db, "cron_jobs");
    migrated = true;
  }
  if (tableExists(db, "installed_plugin_index")) {
    // Fold the singleton index row (revision lived in updated_at_ms) into the KV.
    const row = db
      .prepare(
        `SELECT version, warning, host_contract_version, compat_registry_version,
                migration_version, policy_hash, generated_at_ms, workspace_dir,
                refresh_reason, install_records_json, plugins_json, diagnostics_json,
                updated_at_ms
           FROM installed_plugin_index
          WHERE index_key = 'installed-plugin-index'`,
      )
      .get();
    if (row) {
      const index = {
        version: Number(row.version),
        ...(typeof row.warning === "string" && row.warning ? { warning: row.warning } : {}),
        hostContractVersion: row.host_contract_version,
        compatRegistryVersion: row.compat_registry_version,
        migrationVersion: Number(row.migration_version),
        policyHash: row.policy_hash,
        generatedAtMs: Number(row.generated_at_ms),
        ...(typeof row.workspace_dir === "string" ? { workspaceDir: row.workspace_dir } : {}),
        ...(typeof row.refresh_reason === "string" && row.refresh_reason
          ? { refreshReason: row.refresh_reason }
          : {}),
        installRecords: JSON.parse(String(row.install_records_json)) as unknown,
        plugins: JSON.parse(String(row.plugins_json)) as unknown,
        diagnostics: JSON.parse(String(row.diagnostics_json)) as unknown,
      };
      db.prepare(
        `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
         VALUES (?, ?, ?) ON CONFLICT(state_key) DO NOTHING`,
      ).run(
        "plugins.installedIndex",
        JSON.stringify({ revision: Number(row.updated_at_ms), index }),
        Number(row.updated_at_ms),
      );
    }
    db.exec("DROP TABLE installed_plugin_index;");
    migrated = true;
  }
  if (tableExists(db, "subagent_runs") && tableHasColumn(db, "subagent_runs", "task")) {
    // Shipped pending-delivery columns can hold the only surviving result text.
    repairLegacySubagentRetainedResults(db);
    rebuildJsonCanonicalTable(db, "subagent_runs");
    migrated = true;
  }
  return migrated;
}
