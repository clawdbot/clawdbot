// Receipt lookup and source-removal bookkeeping for legacy workspace migration.
import { createHash } from "node:crypto";
import path from "node:path";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { LegacyWorkspaceStateSource } from "./state-migrations.workspace-setup.types.js";

type WorkspaceReceiptDatabase = Pick<OpenClawStateKyselyDatabase, "migration_sources">;

export type MigrationReceipt = {
  sourceKey: string;
  sha256: string | null;
  removedSource: boolean;
};

export function resolveWorkspaceMigrationSourceKey(source: LegacyWorkspaceStateSource): string {
  return `workspace-${source.kind}:${createHash("sha256")
    .update(source.workspaceKey)
    .update("\0")
    .update(path.resolve(source.sourcePath))
    .digest("hex")}`;
}

export function readReceipt(
  source: LegacyWorkspaceStateSource,
  env: NodeJS.ProcessEnv,
): MigrationReceipt | null {
  const key = resolveWorkspaceMigrationSourceKey(source);
  const { db } = openOpenClawStateDatabase({ env });
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<WorkspaceReceiptDatabase>(db)
      .selectFrom("migration_sources")
      .select(["source_sha256", "removed_source"])
      .where("source_key", "=", key),
  );
  return row
    ? { sourceKey: key, sha256: row.source_sha256, removedSource: row.removed_source === 1 }
    : null;
}

export function markSourceRemoved(sourceKey: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<WorkspaceReceiptDatabase>(db)
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
  );
}
