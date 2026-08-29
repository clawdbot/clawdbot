import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { repairLegacySubagentRetainedResults } from "./openclaw-state-db-legacy-backfills.js";
import {
  rebuildCanonicalStateTable,
  tableExists,
  tableHasColumn,
} from "./openclaw-state-db-schema-helpers.js";
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
    const job = asNullableRecord(safeParseJson(row.job_json));
    const state = asNullableRecord(safeParseJson(row.state_json));
    if (!job || !state) {
      continue;
    }
    let changed = false;
    const delivery = asNullableRecord(job.delivery);
    const destination = asNullableRecord(delivery?.failureDestination);
    if (
      (!Object.hasOwn(job, "delivery") || delivery !== null) &&
      (!delivery || !Object.hasOwn(delivery, "failureDestination") || destination !== null)
    ) {
      const nextDelivery = delivery ?? {};
      const nextDestination = destination ?? {};
      for (const [columnName, fieldName] of FAILURE_DESTINATION_COLUMNS) {
        const value = row[columnName];
        if (typeof value !== "string" || Object.hasOwn(nextDestination, fieldName)) {
          continue;
        }
        nextDestination[fieldName] = value === "" ? null : value;
        changed = true;
      }
      if (changed) {
        nextDelivery.failureDestination = nextDestination;
        job.delivery = nextDelivery;
      }
    }
    const hasLegacyStatus = Object.hasOwn(state, "lastStatus");
    if (
      !Object.hasOwn(state, "lastRunStatus") &&
      (hasLegacyStatus || typeof row.last_run_status === "string")
    ) {
      state.lastRunStatus = hasLegacyStatus ? state.lastStatus : row.last_run_status;
      changed = true;
    }
    if (changed) {
      update.run(JSON.stringify(job), JSON.stringify(state), row.store_key, row.job_id);
    }
  }
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
    rebuildCanonicalStateTable(db, "cron_jobs", 13, OPENCLAW_STATE_SCHEMA_SQL);
    migrated = true;
  }
  const hasSetupState = tableExists(db, "workspace_setup_state");
  const hasAttestations = tableExists(db, "workspace_attestations");
  if (hasSetupState && !tableHasColumn(db, "workspace_setup_state", "attested_at_ms")) {
    // Grow the old table, then rebuild to the canonical merged shape (version
    // and updated_at relax to nullable so attestation-only rows can exist).
    db.exec("ALTER TABLE workspace_setup_state ADD COLUMN attested_at_ms INTEGER;");
    db.exec("ALTER TABLE workspace_setup_state ADD COLUMN attestation_updated_at_ms INTEGER;");
    rebuildCanonicalStateTable(db, "workspace_setup_state", 13, OPENCLAW_STATE_SCHEMA_SQL);
    migrated = true;
  }
  if (hasAttestations) {
    db.exec(`
      UPDATE workspace_setup_state
         SET attested_at_ms = (
               SELECT attested_at_ms FROM workspace_attestations
                WHERE workspace_attestations.workspace_key = workspace_setup_state.workspace_key
             ),
             attestation_updated_at_ms = (
               SELECT updated_at_ms FROM workspace_attestations
                WHERE workspace_attestations.workspace_key = workspace_setup_state.workspace_key
             )
       WHERE workspace_key IN (SELECT workspace_key FROM workspace_attestations);
    `);
    // Attestation-only workspaces borrow their path from an alias when one
    // exists; the legacy attestation table never stored a path, so orphans
    // keep a NULL path and heal it when the workspace next appears.
    db.exec(`
      INSERT INTO workspace_setup_state (
        workspace_key, workspace_path, attested_at_ms, attestation_updated_at_ms
      )
      SELECT a.workspace_key,
             (SELECT alias.workspace_path FROM workspace_path_aliases alias
               WHERE alias.workspace_key = a.workspace_key LIMIT 1),
             a.attested_at_ms,
             a.updated_at_ms
        FROM workspace_attestations a
       WHERE a.workspace_key NOT IN (SELECT workspace_key FROM workspace_setup_state);
    `);
    db.exec("DROP TABLE workspace_attestations;");
    migrated = true;
  }
  if (
    (hasSetupState || hasAttestations) &&
    tableExists(db, "workspace_generated_bootstrap_hashes")
  ) {
    // Repoint the FK to the merged table and drop hashes whose owner row is gone.
    rebuildCanonicalStateTable(
      db,
      "workspace_generated_bootstrap_hashes",
      13,
      OPENCLAW_STATE_SCHEMA_SQL,
    );
    db.exec(`
      DELETE FROM workspace_generated_bootstrap_hashes
       WHERE workspace_key NOT IN (SELECT workspace_key FROM workspace_setup_state);
    `);
  }
  for (const [tableName, jsonColumn, stateKey] of [
    ["auth_profile_stores", "store_json", "authProfiles.store"],
    ["auth_profile_state", "state_json", "authProfiles.state"],
  ] as const) {
    if (!tableExists(db, tableName)) {
      continue;
    }
    // Shared-state singletons keyed 'shared'; the agent-DB twins are untouched.
    db.prepare(
      `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
       SELECT ?, ${jsonColumn}, updated_at FROM ${tableName} WHERE store_key = 'shared'
       ON CONFLICT(state_key) DO NOTHING`,
    ).run(stateKey);
    db.exec(`DROP TABLE ${tableName};`);
    migrated = true;
  }
  if (tableExists(db, "installed_plugin_index")) {
    // Fold the singleton index row (revision lived in updated_at_ms) into the KV.
    // workspace_dir was a same-version additive column; pre-addition rows lack it.
    const workspaceDirColumn = tableHasColumn(db, "installed_plugin_index", "workspace_dir")
      ? "workspace_dir"
      : "NULL AS workspace_dir";
    const rawRow = db
      .prepare(
        `SELECT version, warning, host_contract_version, compat_registry_version,
                migration_version, policy_hash, generated_at_ms, ${workspaceDirColumn},
                refresh_reason, install_records_json, plugins_json, diagnostics_json,
                updated_at_ms
           FROM installed_plugin_index
          WHERE index_key = 'installed-plugin-index'`,
      )
      .get();
    const installRecords = asNullableRecord(
      safeParseJson(String(rawRow?.install_records_json ?? "")),
    );
    const plugins = safeParseJson(String(rawRow?.plugins_json ?? ""));
    const diagnostics = safeParseJson(String(rawRow?.diagnostics_json ?? ""));
    const row =
      rawRow && installRecords && Array.isArray(plugins) && Array.isArray(diagnostics)
        ? rawRow
        : undefined;
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
        installRecords,
        plugins,
        diagnostics,
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
    rebuildCanonicalStateTable(db, "subagent_runs", 13, OPENCLAW_STATE_SCHEMA_SQL);
    migrated = true;
  }
  return migrated;
}
