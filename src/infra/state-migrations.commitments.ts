// Doctor-only cleanup for retired inferred-commitment state.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  claimAndRemoveLegacyMigrationSource,
  readLegacyMigrationSourceSnapshotSync,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

function resolveLegacyCommitmentsPath(stateDir: string): string {
  return path.join(stateDir, "commitments", "commitments.json");
}

function countRetiredCommitmentRows(stateDir: string): number {
  const databasePath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  if (!fs.existsSync(databasePath)) {
    return 0;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'commitments'",
      )
      .get();
    if (!table) {
      return 0;
    }
    const count = database.prepare("SELECT COUNT(*) AS count FROM commitments").get()?.count;
    return typeof count === "number" ? count : 0;
  } finally {
    database.close();
  }
}

export function detectRetiredCommitments(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["commitments"] {
  const sourcePath = resolveLegacyCommitmentsPath(params.stateDir);
  const doctorOnly = params.doctorOnlyStateMigrations === true;
  const hasLegacyFile = doctorOnly && fs.existsSync(sourcePath);
  const rowCount = doctorOnly ? countRetiredCommitmentRows(params.stateDir) : 0;
  return {
    sourcePath,
    hasLegacyFile,
    rowCount,
    hasLegacy: hasLegacyFile || rowCount > 0,
  };
}

export function discardRetiredCommitments(params: {
  detected: LegacyStateDetection["commitments"];
  stateDir: string;
  removeSource?: (sourcePath: string) => void;
}): MigrationMessages {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let removedRows = 0;
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        removedRows = Number(db.prepare("DELETE FROM commitments").run().changes);
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (error) {
    warnings.push(`Failed removing retired commitment rows: ${String(error)}`);
    return { changes, warnings };
  }
  if (removedRows > 0) {
    changes.push(`Removed ${removedRows} retired commitment row${removedRows === 1 ? "" : "s"}`);
  }

  if (params.detected.hasLegacyFile) {
    try {
      const snapshot = readLegacyMigrationSourceSnapshotSync({
        sourcePath: params.detected.sourcePath,
        label: "commitments",
      });
      claimAndRemoveLegacyMigrationSource({
        sourcePath: params.detected.sourcePath,
        snapshot,
        label: "commitments",
        removeSource: params.removeSource,
      });
      changes.push("Removed retired commitments JSON");
    } catch (error) {
      warnings.push(
        `Failed removing retired commitments state ${params.detected.sourcePath}: ${String(error)}`,
      );
    }
  }
  return { changes, warnings };
}
