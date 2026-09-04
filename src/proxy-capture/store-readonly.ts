import { gunzipSync } from "node:zlib";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type DebugProxyCaptureDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "capture_events" | "capture_blobs"
>;
type NodeSqliteDatabase = Parameters<typeof getNodeSqliteKysely>[0];

export type DebugProxyCaptureReader = {
  getSessionEvents(sessionId: string, limit?: number): Array<Record<string, unknown>>;
  readBlob(blobId: string): string | null;
};

export function readDebugProxyCaptureSessionEvents(
  db: NodeSqliteDatabase,
  sessionId: string,
  limit = 500,
): Array<Record<string, unknown>> {
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DebugProxyCaptureDatabase>(db)
      .selectFrom("capture_events")
      .select([
        "id",
        "session_id as sessionId",
        "ts",
        "source_scope as sourceScope",
        "source_process as sourceProcess",
        "protocol",
        "direction",
        "kind",
        "flow_id as flowId",
        "method",
        "host",
        "path",
        "status",
        "close_code as closeCode",
        "content_type as contentType",
        "headers_json as headersJson",
        "data_text as dataText",
        "data_blob_id as dataBlobId",
        "data_sha256 as dataSha256",
        "error_text as errorText",
        "meta_json as metaJson",
      ])
      .where("session_id", "=", sessionId)
      .orderBy("ts", "desc")
      .orderBy("id", "desc")
      .limit(limit),
  ).rows;
}

export function readDebugProxyCaptureBlob(db: NodeSqliteDatabase, blobId: string): string | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DebugProxyCaptureDatabase>(db)
      .selectFrom("capture_blobs")
      .select(["encoding", "data"])
      .where("blob_id", "=", blobId),
  );
  if (!row?.data) {
    return null;
  }
  const data = Buffer.from(row.data);
  return (row.encoding === "gzip" ? gunzipSync(data) : data).toString("utf8");
}

/** Read capture rows without joining or mutating the shared-state writer lifecycle. */
export function createDebugProxyCaptureReader(params: {
  env: NodeJS.ProcessEnv;
}): DebugProxyCaptureReader {
  return {
    getSessionEvents(sessionId, limit) {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => readDebugProxyCaptureSessionEvents(db, sessionId, limit),
          { env: params.env },
        ) ?? []
      );
    },
    readBlob(blobId) {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => readDebugProxyCaptureBlob(db, blobId),
          { env: params.env },
        ) ?? null
      );
    },
  };
}
