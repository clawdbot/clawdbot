import { gunzipSync } from "node:zlib";
import { normalizeNullableString as normalizeObservedValue } from "@openclaw/normalization-core/string-coerce";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { CaptureObservedDimension, CaptureSessionCoverageSummary } from "./types.js";

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

// Metadata is optional and user/tool supplied, so parse defensively for coverage
// summaries instead of assuming every event has valid JSON.
function parseMetaJson(metaJson: unknown): Record<string, unknown> | null {
  if (typeof metaJson !== "string" || metaJson.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    // SAFETY: Parsed objects, including arrays, are read only through optional label keys.
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sortObservedCounts(counts: Map<string, number>): CaptureObservedDimension[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export function summarizeDebugProxyCaptureSessionCoverage(
  db: NodeSqliteDatabase,
  sessionId: string,
): CaptureSessionCoverageSummary {
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
    getNodeSqliteKysely<DebugProxyCaptureDatabase>(db)
      .selectFrom("capture_events")
      .select(["host", "meta_json as metaJson"])
      .where(
        "session_id",
        "=",
        parameter((value) => value),
      ),
  );
  // Native iteration keeps corruption from evicting the borrowed shared database.
  const rows = db /* sqlite-allow-raw -- Execute Kysely SQL with native failure ownership. */
    .prepare(compiled.sql)
    .iterate(...bind(sessionId));
  const providers = new Map<string, number>();
  const apis = new Map<string, number>();
  const models = new Map<string, number>();
  const hosts = new Map<string, number>();
  const localPeers = new Map<string, number>();
  let totalEvents = 0;
  let unlabeledEventCount = 0;
  try {
    for (const row of rows) {
      totalEvents += 1;
      const meta = parseMetaJson(row.metaJson);
      const provider = normalizeObservedValue(meta?.provider);
      const api = normalizeObservedValue(meta?.api);
      const model = normalizeObservedValue(meta?.model);
      const host = normalizeObservedValue(row.host);
      if (!provider && !api && !model) {
        unlabeledEventCount += 1;
      }
      if (provider) {
        providers.set(provider, (providers.get(provider) ?? 0) + 1);
      }
      if (api) {
        apis.set(api, (apis.get(api) ?? 0) + 1);
      }
      if (model) {
        models.set(model, (models.get(model) ?? 0) + 1);
      }
      if (host) {
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
        // Local model/provider endpoints are useful to surface separately when
        // debugging why cloud-provider labels are absent.
        if (host.startsWith("127.0.0.1:") || host.startsWith("localhost:")) {
          localPeers.set(host, (localPeers.get(host) ?? 0) + 1);
        }
      }
    }
  } catch (error) {
    try {
      rows.return?.();
    } catch {
      // Iterator cleanup must not replace the original read failure.
    }
    throw error;
  }
  return {
    sessionId,
    totalEvents,
    unlabeledEventCount,
    providers: sortObservedCounts(providers),
    apis: sortObservedCounts(apis),
    models: sortObservedCounts(models),
    hosts: sortObservedCounts(hosts),
    localPeers: sortObservedCounts(localPeers),
  };
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
