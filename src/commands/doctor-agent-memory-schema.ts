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

const MEMORY_RECALL_METADATA_COLUMNS = ["importance", "triggers"] as const;

type MemoryRecallMetadataColumn = (typeof MEMORY_RECALL_METADATA_COLUMNS)[number];

type DoctorAgentMemorySchemaRepair = {
  agentId: string;
  columns: readonly MemoryRecallMetadataColumn[];
  path: string;
};

type DoctorAgentMemorySchemaReport = {
  repaired: readonly DoctorAgentMemorySchemaRepair[];
  warnings: readonly string[];
};

function readMissingMemoryRecallMetadataColumns(
  database: DatabaseSync,
): MemoryRecallMetadataColumn[] | null {
  const rows =
    /* sqlite-allow-raw -- Read-only schema inspection before doctor maintenance. */ database
      .prepare("PRAGMA table_info(memory_index_chunks)")
      .all() as Array<{ name?: unknown }>;
  if (rows.length === 0) {
    return null;
  }
  const columns = new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
  return MEMORY_RECALL_METADATA_COLUMNS.filter((column) => !columns.has(column));
}

function inspectAgentMemoryRecallMetadataColumns(
  pathname: string,
): MemoryRecallMetadataColumn[] | null {
  const stat = fs.lstatSync(pathname);
  if (!stat.isFile()) {
    throw new Error(`OpenClaw agent database is not a regular file: ${pathname}`);
  }
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return readMissingMemoryRecallMetadataColumns(database);
  } finally {
    database.close();
  }
}

/** Eagerly canonicalize memory recall columns in every registered agent database. */
function repairDoctorAgentMemorySchemas(
  options: { env?: NodeJS.ProcessEnv } = {},
): DoctorAgentMemorySchemaReport {
  const env = options.env ?? process.env;
  const repaired: DoctorAgentMemorySchemaRepair[] = [];
  const warnings: string[] = [];
  let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
  try {
    registered = listOpenClawRegisteredAgentDatabases({ env });
  } catch (error) {
    return {
      repaired,
      warnings: [`Could not inspect registered agent databases: ${formatErrorMessage(error)}`],
    };
  }

  for (const entry of registered) {
    try {
      const missing = inspectAgentMemoryRecallMetadataColumns(entry.path);
      if (!missing || missing.length === 0) {
        continue;
      }
      // Doctor owns offline maintenance. Close any handle opened by an earlier
      // doctor contribution before the feature owner ALTERs the shared table.
      closeOpenClawAgentDatabaseByPath(entry.path);
      migrateOpenClawAgentDatabaseForMaintenance({
        agentId: entry.agentId,
        pathname: entry.path,
      });
      const remaining = inspectAgentMemoryRecallMetadataColumns(entry.path);
      if (remaining === null || remaining.length > 0) {
        throw new Error(
          `memory_index_chunks did not converge on the recall metadata schema (${remaining?.join(", ") ?? "table missing"})`,
        );
      }
      repaired.push({ agentId: entry.agentId, columns: missing, path: entry.path });
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
        .map(
          (repair) =>
            `- Agent ${repair.agentId}: added ${repair.columns
              .map((column) => `memory_index_chunks.${column}`)
              .join(", ")} (${shortenHomePath(repair.path)}).`,
        )
        .join("\n"),
      "Doctor changes",
    );
  }
  if (report.warnings.length > 0) {
    writeNote(report.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return report;
}
