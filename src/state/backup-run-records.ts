import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { BACKUP_RUN_ERROR_MAX_LENGTH } from "./backup-run-records.contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type BackupRunDatabase = Pick<OpenClawStateDatabase, "backup_runs">;

type BackupRunKind = "archive" | "sqlite-snapshot" | "git";

export type BackupRunRecord = {
  id: string;
  createdAt: number;
  archivePath: string;
  status: "ok" | "failed";
  kind: BackupRunKind;
  target?: string;
  error?: string;
  pushFailed?: true;
};

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxLength) : undefined;
}

function parseBackupRun(row: {
  id: string;
  created_at: number;
  archive_path: string;
  status: string;
  manifest_json: string;
}): BackupRunRecord | undefined {
  if (row.status !== "ok" && row.status !== "failed") {
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(row.manifest_json) as unknown;
  } catch {
    return undefined;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return undefined;
  }
  const value = manifest as Record<string, unknown>;
  if (value.kind !== "archive" && value.kind !== "sqlite-snapshot" && value.kind !== "git") {
    return undefined;
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    archivePath: row.archive_path,
    status: row.status,
    kind: value.kind,
    ...(typeof value.target === "string" ? { target: value.target } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(value.pushFailed === true ? { pushFailed: true } : {}),
  };
}

/** Record one best-effort backup outcome in the shared bounded operational log. */
export function recordBackupRunOutcome(params: {
  archivePath: string;
  status: "ok" | "failed";
  kind: BackupRunKind;
  target?: string;
  error?: string;
  pushFailed?: boolean;
  createdAt?: number;
  env?: NodeJS.ProcessEnv;
}): void {
  // Best-effort log only: never bootstrap an absent state database to record an
  // outcome, or a failed backup on a fresh host would create a blank DB that a
  // retry then treats as real backup input.
  if (!existsSync(resolveOpenClawStateSqlitePath(params.env ?? process.env))) {
    return;
  }
  const manifest = JSON.stringify({
    kind: params.kind,
    ...(boundedText(params.target, 512) ? { target: boundedText(params.target, 512) } : {}),
    ...(boundedText(params.error, BACKUP_RUN_ERROR_MAX_LENGTH)
      ? { error: boundedText(params.error, BACKUP_RUN_ERROR_MAX_LENGTH) }
      : {}),
    ...(params.pushFailed === true ? { pushFailed: true } : {}),
  });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<BackupRunDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely.insertInto("backup_runs").values({
          id: randomUUID(),
          created_at: params.createdAt ?? Date.now(),
          archive_path: params.archivePath,
          status: params.status,
          manifest_json: manifest,
        }),
      );
      // This is a bounded operational log. Hourly scheduled backups must not grow it forever.
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("backup_runs")
          .where(
            "id",
            "in",
            kysely
              .selectFrom("backup_runs")
              .select("id")
              .orderBy("created_at", "desc")
              .orderBy("id", "desc")
              .limit(2_147_483_647)
              .offset(200),
          ),
      );
    },
    { env: params.env },
  );
}

function readBackupRun(database: DatabaseSync, status?: "ok"): BackupRunRecord | undefined {
  // backup_runs is same-version additive: an older v6 database may not have it
  // until a writable open converges the schema. Read-only freshness paths must
  // treat that as "no recorded backups", never as an error.
  if (!tableExists(database, "backup_runs")) {
    return undefined;
  }
  const kysely = getNodeSqliteKysely<BackupRunDatabase>(database);
  let query = kysely.selectFrom("backup_runs").selectAll();
  if (status) {
    query = query.where("status", "=", status);
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    query.orderBy("created_at", "desc").orderBy("id", "desc").limit(1),
  );
  return row ? parseBackupRun(row) : undefined;
}

/** Read the newest recorded backup attempt from an already-open database. */
export function readLatestBackupRun(database: DatabaseSync): BackupRunRecord | undefined {
  return readBackupRun(database);
}

/** Read the newest successful backup from an already-open database. */
export function readLatestSuccessfulBackupRun(database: DatabaseSync): BackupRunRecord | undefined {
  return readBackupRun(database, "ok");
}
