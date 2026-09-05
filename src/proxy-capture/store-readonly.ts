import { gunzipSync } from "node:zlib";
import { normalizeNullableString as normalizeObservedValue } from "@openclaw/normalization-core/string-coerce";
import type { Compilable, InferResult } from "kysely";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type {
  CaptureObservedDimension,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
} from "./types.js";

type DebugProxyCaptureDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "capture_sessions" | "capture_events" | "capture_blobs"
>;
type NodeSqliteDatabase = Parameters<typeof getNodeSqliteKysely>[0];

export type DebugProxyCaptureReader = {
  getSessionEvents(sessionId: string, limit?: number): Array<Record<string, unknown>>;
  readBlob(blobId: string): string | null;
};

export function listDebugProxyCaptureSessions(db: NodeSqliteDatabase, limit = 50) {
  const query = getNodeSqliteKysely<DebugProxyCaptureDatabase>(db)
    .selectFrom("capture_sessions as s")
    .leftJoin("capture_events as e", "e.session_id", "s.id")
    .select([
      "s.id",
      "s.started_at as startedAt",
      "s.ended_at as endedAt",
      "s.mode",
      "s.source_process as sourceProcess",
      "s.proxy_url as proxyUrl",
    ])
    .select((eb) => eb.fn.count<number>("e.id").as("eventCount"))
    .groupBy("s.id")
    .orderBy("s.started_at", "desc")
    .limit(limit);
  const { compiled, bind } = compileSqliteQueryBindings(() => query);
  // Native reads retain the store's failure ownership without evicting its borrowed DB.
  return db /* sqlite-allow-raw -- Execute Kysely SQL with native failure ownership. */
    .prepare(compiled.sql)
    .all(...bind(undefined)) as InferResult<typeof query>; // SAFETY: Native columns follow this generated projection.
}

export function findDebugProxyCaptureBlobReference(
  db: NodeSqliteDatabase,
  blobId: string,
): string | null {
  const query = getNodeSqliteKysely<DebugProxyCaptureDatabase>(db)
    .selectFrom("capture_events")
    .select("data_blob_id as blobId")
    .where("data_blob_id", "=", blobId)
    .limit(1);
  const { compiled, bind } = compileSqliteQueryBindings(() => query);
  const row = db /* sqlite-allow-raw -- Execute Kysely SQL with native failure ownership. */
    .prepare(compiled.sql)
    .get(...bind(undefined)) as InferResult<typeof query>[number] | undefined; // SAFETY: Native lookup returns the selected nullable text column.
  return row?.blobId || null;
}

export function queryDebugProxyCapturePreset(
  db: NodeSqliteDatabase,
  preset: CaptureQueryPreset,
  sessionId?: string,
): CaptureQueryRow[] {
  const kysely = getNodeSqliteKysely<DebugProxyCaptureDatabase>(db);
  let events = kysely.selectFrom("capture_events");
  if (sessionId) {
    events = events.where("session_id", "=", sessionId);
  }
  const locations = events.select(["host", "path"]);
  const count = kysely.fn.countAll<number>();
  let query: Compilable<CaptureQueryRow>;
  // Aggregate in SQLite so diagnostics do not hydrate whole capture sessions.
  switch (preset) {
    case "double-sends":
      query = locations
        .select(["method", count.as("duplicateCount")])
        .where("kind", "=", "request")
        .groupBy(["host", "path", "method", "data_sha256"])
        .having(count, ">", 1)
        .orderBy("duplicateCount", "desc")
        .orderBy("host", "asc");
      break;
    case "retry-storms":
      query = locations
        .select(count.as("errorCount"))
        .where("kind", "=", "response")
        .where("status", ">=", 429)
        .groupBy(["host", "path"])
        .having(count, ">", 1)
        .orderBy("errorCount", "desc")
        .orderBy("host", "asc");
      break;
    case "cache-busting":
      query = locations
        .select(count.as("variantCount"))
        .where("kind", "=", "request")
        .where((eb) =>
          eb.or([
            eb("path", "like", "%?%"),
            eb("headers_json", "like", "%cache-control%"),
            eb("headers_json", "like", "%pragma%"),
          ]),
        )
        .groupBy(["host", "path"])
        .orderBy("variantCount", "desc")
        .orderBy("host", "asc");
      break;
    case "ws-duplicate-frames":
      query = locations
        .select(count.as("duplicateFrames"))
        .where("kind", "=", "ws-frame")
        .where("direction", "=", "outbound")
        .groupBy(["host", "path", "data_sha256"])
        .having(count, ">", 1)
        .orderBy("duplicateFrames", "desc")
        .orderBy("host", "asc");
      break;
    case "missing-ack":
      query = events
        .select(["flow_id as flowId", "host", "path", count.as("outboundFrames")])
        .where("kind", "=", "ws-frame")
        .where("direction", "=", "outbound")
        .where(
          "flow_id",
          "not in",
          events
            .select("flow_id")
            .where("kind", "=", "ws-frame")
            .where("direction", "=", "inbound"),
        )
        .groupBy(["flow_id", "host", "path"])
        .orderBy("outboundFrames", "desc");
      break;
    case "error-bursts":
      query = locations
        .select(count.as("errorCount"))
        .where("kind", "=", "error")
        .groupBy(["host", "path"])
        .orderBy("errorCount", "desc")
        .orderBy("host", "asc");
      break;
    default:
      return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings(() => query);
  return db /* sqlite-allow-raw -- Execute Kysely SQL with native failure ownership. */
    .prepare(compiled.sql)
    .all(...bind(undefined)) as CaptureQueryRow[]; // SAFETY: Each typed preset selects only text, count, or nullable columns.
}

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
