// Canonical shared-SQLite store for managed outgoing image metadata.
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

export const MANAGED_OUTGOING_ORIGINALS_SUBDIR = "outgoing/originals";

type ManagedImageRecordVariant = {
  mediaRoot: string;
  mediaId: string;
  mediaSubdir: string;
  contentType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  filename: string | null;
};

type ManagedImageRetentionClass = "transient" | "history";

export type ManagedImageRecord = {
  attachmentId: string;
  sessionKey: string;
  agentId?: string;
  messageId: string | null;
  createdAt: string;
  updatedAt?: string;
  retentionClass?: ManagedImageRetentionClass;
  alt: string;
  original: ManagedImageRecordVariant;
};

export type ManagedImageRecordDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "managed_outgoing_image_records"
>;
type ManagedImageRecordRow = Selectable<
  ManagedImageRecordDatabase["managed_outgoing_image_records"]
>;
type ManagedImageRecordInsert = Insertable<
  ManagedImageRecordDatabase["managed_outgoing_image_records"]
>;
type ManagedImageRecordEntry = {
  record: ManagedImageRecord;
  cleanupPending: boolean;
};

function stateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

export function managedImageRecordToRow(record: ManagedImageRecord): ManagedImageRecordInsert {
  return {
    attachment_id: record.attachmentId,
    session_key: record.sessionKey,
    agent_id: record.agentId ?? null,
    message_id: record.messageId,
    created_at: record.createdAt,
    updated_at: record.updatedAt ?? null,
    retention_class: record.retentionClass ?? null,
    alt: record.alt,
    original_media_root: record.original.mediaRoot,
    original_media_id: record.original.mediaId,
    original_media_subdir: record.original.mediaSubdir,
    original_content_type: record.original.contentType,
    original_width: record.original.width,
    original_height: record.original.height,
    original_size_bytes: record.original.sizeBytes,
    original_filename: record.original.filename,
    record_json: JSON.stringify(record),
  };
}

export function managedImageRecordFromRow(row: ManagedImageRecordRow): ManagedImageRecord {
  return {
    attachmentId: row.attachment_id,
    sessionKey: row.session_key,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    messageId: row.message_id,
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    ...(row.retention_class === "history" || row.retention_class === "transient"
      ? { retentionClass: row.retention_class }
      : {}),
    alt: row.alt,
    original: {
      mediaRoot: row.original_media_root,
      mediaId: row.original_media_id,
      mediaSubdir: row.original_media_subdir,
      contentType: row.original_content_type,
      width: row.original_width,
      height: row.original_height,
      sizeBytes: row.original_size_bytes,
      filename: row.original_filename,
    },
  };
}

export function managedImageRecordsEqual(
  left: ManagedImageRecord,
  right: ManagedImageRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function readManagedImageRecord(
  attachmentId: string,
  stateDir?: string,
): ManagedImageRecord | null {
  const database = openOpenClawStateDatabase(stateDatabaseOptions(stateDir));
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db)
      .selectFrom("managed_outgoing_image_records")
      .selectAll()
      .where("attachment_id", "=", attachmentId)
      .where("cleanup_pending", "=", 0),
  );
  return row ? managedImageRecordFromRow(row) : null;
}

export function listManagedImageRecordEntries(params: {
  stateDir?: string;
  sessionKey?: string;
}): ManagedImageRecordEntry[] {
  const database = openOpenClawStateDatabase(stateDatabaseOptions(params.stateDir));
  const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db);
  let query = stateDb.selectFrom("managed_outgoing_image_records").selectAll();
  if (params.sessionKey) {
    query = query.where("session_key", "=", params.sessionKey);
  }
  return executeSqliteQuerySync(
    database.db,
    query.orderBy("created_at", "desc").orderBy("attachment_id", "asc"),
  ).rows.map((row) => ({
    record: managedImageRecordFromRow(row),
    cleanupPending: row.cleanup_pending === 1,
  }));
}

export function insertManagedImageRecord(record: ManagedImageRecord, stateDir?: string): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(db)
        .insertInto("managed_outgoing_image_records")
        .values(managedImageRecordToRow(record)),
    );
  }, stateDatabaseOptions(stateDir));
}

/** Promote a transient record atomically so concurrent message commits cannot lose state. */
export function attachManagedImageRecordToMessage(params: {
  attachmentId: string;
  sessionKey: string;
  messageId: string;
  updatedAt: string;
  stateDir?: string;
}): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("managed_outgoing_image_records")
        .selectAll()
        .where("attachment_id", "=", params.attachmentId)
        .where("session_key", "=", params.sessionKey),
    );
    if (!row) {
      return false;
    }
    if (row.cleanup_pending === 1) {
      return false;
    }
    const current = managedImageRecordFromRow(row);
    if (current.messageId === params.messageId && current.retentionClass === "history") {
      return true;
    }
    const next: ManagedImageRecord = {
      ...current,
      messageId: params.messageId,
      retentionClass: "history",
      updatedAt: params.updatedAt,
    };
    const nextRow = managedImageRecordToRow(next);
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("managed_outgoing_image_records")
        .set({
          message_id: nextRow.message_id,
          retention_class: nextRow.retention_class,
          updated_at: nextRow.updated_at,
          record_json: nextRow.record_json,
        })
        .where("attachment_id", "=", params.attachmentId),
    );
    return true;
  }, stateDatabaseOptions(params.stateDir));
}

/** Claim only the exact row cleanup planned against; concurrent updates win. */
export function claimManagedImageRecordCleanupIfCurrent(
  planned: ManagedImageRecord,
  stateDir?: string,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("managed_outgoing_image_records")
        .selectAll()
        .where("attachment_id", "=", planned.attachmentId),
    );
    if (
      !row ||
      row.cleanup_pending === 1 ||
      !managedImageRecordsEqual(managedImageRecordFromRow(row), planned)
    ) {
      return false;
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("managed_outgoing_image_records")
        .set({ cleanup_pending: 1 })
        .where("attachment_id", "=", planned.attachmentId),
    );
    return true;
  }, stateDatabaseOptions(stateDir));
}

/** Delete a durably claimed row only after its attachment file is gone. */
export function deleteClaimedManagedImageRecord(
  planned: ManagedImageRecord,
  stateDir?: string,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ManagedImageRecordDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("managed_outgoing_image_records")
        .selectAll()
        .where("attachment_id", "=", planned.attachmentId),
    );
    if (
      !row ||
      row.cleanup_pending !== 1 ||
      !managedImageRecordsEqual(managedImageRecordFromRow(row), planned)
    ) {
      return false;
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("managed_outgoing_image_records")
        .where("attachment_id", "=", planned.attachmentId),
    );
    return true;
  }, stateDatabaseOptions(stateDir));
}
