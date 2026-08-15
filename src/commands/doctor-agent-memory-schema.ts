import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  listOpenClawRegisteredAgentDatabases,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "../state/openclaw-agent-db.js";
import { shortenHomePath } from "../utils.js";
import {
  DoctorSqliteMaintenanceLockUnavailableError,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

const LEGACY_MEMORY_RECALL_METADATA_COLUMNS = ["importance", "triggers", "project_key"] as const;
const LEGACY_MEMORY_PROVENANCE_TRIGGER = "memory_index_chunk_provenance_after_insert";
const MEMORY_RECALL_METADATA_TABLE = "memory_index_chunk_recall_metadata";

type LegacyMemoryRecallMetadataColumn = (typeof LEGACY_MEMORY_RECALL_METADATA_COLUMNS)[number];

type DoctorAgentMemorySchemaRepair = {
  agentId: string;
  columns: readonly LegacyMemoryRecallMetadataColumn[];
  path: string;
  removedTrigger: boolean;
};

type DoctorAgentMemorySchemaReport = {
  repaired: readonly DoctorAgentMemorySchemaRepair[];
  warnings: readonly string[];
};

type MemoryRecallMetadataMigrationState = {
  columns: LegacyMemoryRecallMetadataColumn[];
  hasMetadataTable: boolean;
  hasProvenanceTrigger: boolean;
};

function readMemoryRecallMetadataMigrationState(
  database: DatabaseSync,
): MemoryRecallMetadataMigrationState | null {
  const rows =
    /* sqlite-allow-raw -- Read-only schema inspection before doctor maintenance. */ database
      .prepare("PRAGMA table_info(memory_index_chunks)")
      .all() as Array<{ name?: unknown }>;
  if (rows.length === 0) {
    return null;
  }
  const columns = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  return {
    columns: LEGACY_MEMORY_RECALL_METADATA_COLUMNS.filter((column) => columns.has(column)),
    hasMetadataTable: Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(MEMORY_RECALL_METADATA_TABLE),
    ),
    hasProvenanceTrigger: Boolean(
      database
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
        .get(LEGACY_MEMORY_PROVENANCE_TRIGGER),
    ),
  };
}

function inspectAgentMemoryRecallMetadataMigration(
  pathname: string,
): MemoryRecallMetadataMigrationState | null {
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile()) {
    throw new Error(`OpenClaw agent database is not a regular file: ${pathname}`);
  }
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return readMemoryRecallMetadataMigrationState(database);
  } finally {
    database.close();
  }
}

/** Move the unreleased inline metadata shape into rollback-safe additive tables. */
function repairDoctorAgentMemorySchemas(
  options: { env?: NodeJS.ProcessEnv } = {},
): DoctorAgentMemorySchemaReport {
  const env = options.env ?? process.env;
  const repaired: DoctorAgentMemorySchemaRepair[] = [];
  const warnings: string[] = [];
  let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
  try {
    registered = listOpenClawRegisteredAgentDatabases({
      env,
      includeIncompatibleSchemaVersions: true,
    });
  } catch (error) {
    return {
      repaired,
      warnings: [`Could not inspect registered agent databases: ${formatErrorMessage(error)}`],
    };
  }

  for (const entry of registered) {
    try {
      const before = inspectAgentMemoryRecallMetadataMigration(entry.path);
      if (!before || (before.columns.length === 0 && !before.hasProvenanceTrigger)) {
        continue;
      }
      // Doctor owns offline maintenance. Close any handle opened by an earlier
      // doctor contribution before the feature owner migrates the shared table.
      closeOpenClawAgentDatabaseByPath(entry.path);
      migrateOpenClawAgentDatabaseForMaintenance({
        agentId: entry.agentId,
        pathname: entry.path,
      });
      const after = inspectAgentMemoryRecallMetadataMigration(entry.path);
      if (
        after === null ||
        after.columns.length > 0 ||
        after.hasProvenanceTrigger ||
        !after.hasMetadataTable
      ) {
        throw new Error(
          "memory recall metadata did not converge on rollback-safe additive storage",
        );
      }
      repaired.push({
        agentId: entry.agentId,
        columns: before.columns,
        path: entry.path,
        removedTrigger: before.hasProvenanceTrigger,
      });
    } catch (error) {
      warnings.push(
        `Agent ${entry.agentId} database ${shortenHomePath(entry.path)}: ${formatErrorMessage(error)}`,
      );
    }
  }
  return { repaired, warnings };
}

export async function noteDoctorAgentMemorySchemaHealth(
  params: { env?: NodeJS.ProcessEnv; shouldRepair: boolean },
  deps: { note?: typeof note } = {},
): Promise<DoctorAgentMemorySchemaReport> {
  const writeNote = deps.note ?? note;
  if (!params.shouldRepair) {
    return { repaired: [], warnings: [] };
  }

  let report: DoctorAgentMemorySchemaReport;
  try {
    report = await withDoctorSqliteMaintenanceLock({
      env: params.env,
      operation: "agent memory schema repair",
      run: () => repairDoctorAgentMemorySchemas({ env: params.env }),
    });
  } catch (error) {
    if (!(error instanceof DoctorSqliteMaintenanceLockUnavailableError)) {
      throw error;
    }
    report = { repaired: [], warnings: [error.message] };
  }

  if (report.repaired.length > 0) {
    writeNote(
      report.repaired
        .map((repair) => {
          const changes = [
            repair.columns.length > 0
              ? `moved ${repair.columns
                  .map((column) => `memory_index_chunks.${column}`)
                  .join(", ")} to additive storage`
              : null,
            repair.removedTrigger ? `removed ${LEGACY_MEMORY_PROVENANCE_TRIGGER}` : null,
          ].filter((change): change is string => change !== null);
          return `- Agent ${repair.agentId}: ${changes.join("; ")} (${shortenHomePath(repair.path)}).`;
        })
        .join("\n"),
      "Doctor changes",
    );
  }
  if (report.warnings.length > 0) {
    writeNote(report.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return report;
}
