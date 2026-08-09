// SQLite ownership helpers for Gateway skill-upload staging.
import type { DatabaseSync } from "node:sqlite";
import type { Kysely, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as OpenClawStateDatabase,
  SkillUploads,
} from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

export const SKILL_UPLOAD_LEASE_SCOPE = "skill-upload-install";

export type SkillUploadDatabase = Pick<
  OpenClawStateDatabase,
  "skill_upload_chunks" | "skill_uploads" | "state_leases"
>;
export type SkillUploadRow = Selectable<SkillUploads>;

export function resolveSkillUploadDatabaseOptions(options: {
  env?: NodeJS.ProcessEnv;
  path?: string;
}): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.path ? { path: options.path } : {}),
  };
}

export function openSkillUploadDatabase(options: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(options);
  return {
    database,
    kysely: getNodeSqliteKysely<SkillUploadDatabase>(database.db),
  };
}

export function readSkillUploadRow(
  uploadId: string,
  options: OpenClawStateDatabaseOptions,
): SkillUploadRow | undefined {
  const { database, kysely } = openSkillUploadDatabase(options);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("skill_uploads").selectAll().where("upload_id", "=", uploadId),
  );
}

export function deleteSkillUploadState(
  db: DatabaseSync,
  kysely: Kysely<SkillUploadDatabase>,
  uploadId: string,
): void {
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("state_leases")
      .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
      .where("lease_key", "=", uploadId),
  );
  executeSqliteQuerySync(db, kysely.deleteFrom("skill_uploads").where("upload_id", "=", uploadId));
}

export function deleteOwnedSkillUpload(
  uploadId: string,
  owner: string,
  nowMs: number,
  options: OpenClawStateDatabaseOptions,
): "deleted" | "missing" | "not-owner" {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    const upload = executeSqliteQueryTakeFirstSync(
      db,
      kysely.selectFrom("skill_uploads").select("upload_id").where("upload_id", "=", uploadId),
    );
    if (!upload) {
      return "missing";
    }
    const lease = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("state_leases")
        .select(["owner", "expires_at"])
        .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
        .where("lease_key", "=", uploadId),
    );
    if (!lease || lease.owner !== owner || lease.expires_at === null || lease.expires_at <= nowMs) {
      return "not-owner";
    }
    deleteSkillUploadState(db, kysely, uploadId);
    return "deleted";
  }, options);
}

export function hasLiveSkillUploadInstallLease(
  db: DatabaseSync,
  kysely: Kysely<SkillUploadDatabase>,
  uploadId: string,
  nowMs: number,
): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("state_leases")
        .select("lease_key")
        .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
        .where("lease_key", "=", uploadId)
        .where("expires_at", ">", nowMs),
    ),
  );
}

export function deleteExpiredSkillUploadUnlessLeased(params: {
  uploadId: string;
  nowMs: number;
  options: OpenClawStateDatabaseOptions;
}): "active" | "deleted" | "leased" | "missing" {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("skill_uploads")
        .select("expires_at")
        .where("upload_id", "=", params.uploadId),
    );
    if (!row) {
      return "missing";
    }
    if (row.expires_at > params.nowMs) {
      return "active";
    }
    if (hasLiveSkillUploadInstallLease(db, kysely, params.uploadId, params.nowMs)) {
      return "leased";
    }
    deleteSkillUploadState(db, kysely, params.uploadId);
    return "deleted";
  }, params.options);
}

export function renewSkillUploadInstallLease(params: {
  uploadId: string;
  owner: string;
  heartbeatAt: number;
  expiresAt: number;
  options: OpenClawStateDatabaseOptions;
}): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    return (
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("state_leases")
          .set({
            heartbeat_at: params.heartbeatAt,
            expires_at: params.expiresAt,
            updated_at: params.heartbeatAt,
          })
          .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
          .where("lease_key", "=", params.uploadId)
          .where("owner", "=", params.owner)
          .where("expires_at", ">", params.heartbeatAt),
      ).numAffectedRows === 1n
    );
  }, params.options);
}

export function readSkillUploadArchiveChunks(
  uploadId: string,
  options: OpenClawStateDatabaseOptions,
): Array<{ byte_offset: number; size_bytes: number; chunk_blob: Uint8Array }> {
  const { database, kysely } = openSkillUploadDatabase(options);
  return executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_upload_chunks")
      .select(["byte_offset", "size_bytes", "chunk_blob"])
      .where("upload_id", "=", uploadId)
      .orderBy("byte_offset", "asc"),
  ).rows;
}
