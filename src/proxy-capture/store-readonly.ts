import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";

export type DebugProxyCaptureReader = {
  getSessionEvents(sessionId: string, limit?: number): Array<Record<string, unknown>>;
  readBlob(blobId: string): string | null;
};

export function readDebugProxyCaptureSessionEvents(
  db: DatabaseSync,
  sessionId: string,
  limit = 500,
): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT
         id, session_id AS sessionId, ts, source_scope AS sourceScope, source_process AS sourceProcess,
         protocol, direction, kind, flow_id AS flowId, method, host, path, status, close_code AS closeCode,
         content_type AS contentType, headers_json AS headersJson, data_text AS dataText,
         data_blob_id AS dataBlobId, data_sha256 AS dataSha256, error_text AS errorText, meta_json AS metaJson
       FROM capture_events
       WHERE session_id = ?
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
      )
      // SAFETY: node:sqlite returns one object per projected capture_events row.
      .all(sessionId, limit) as Array<Record<string, unknown>>
  );
}

export function readDebugProxyCaptureBlob(db: DatabaseSync, blobId: string): string | null {
  const row = db
    .prepare(`SELECT encoding, data FROM capture_blobs WHERE blob_id = ?`)
    // SAFETY: the query projects only the capture_blobs encoding and BLOB columns.
    .get(blobId) as { data?: Uint8Array; encoding?: string } | undefined;
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
