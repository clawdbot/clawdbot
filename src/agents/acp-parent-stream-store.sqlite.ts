// ACP parent-stream diagnostics live with their child session in the per-agent database.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";

type AcpParentStreamDatabase = Pick<OpenClawAgentKyselyDatabase, "acp_parent_stream_events">;

export type AcpParentStreamEvent = Record<string, unknown>;

function getAcpParentStreamKysely(database: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<AcpParentStreamDatabase>(database);
}

function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/** Records one ordered batch in the same synchronous commit section as sequence allocation. */
export function recordAcpParentStreamEvents(
  options: OpenClawAgentDatabaseOptions & {
    sessionId: string;
    runId: string;
    events: Array<{ event: AcpParentStreamEvent; createdAt: number }>;
  },
): void {
  if (options.events.length === 0) {
    return;
  }
  const prepared = options.events.flatMap((entry) => {
    try {
      const eventJson = JSON.stringify(entry.event);
      if (eventJson !== undefined) {
        return [{ eventJson, createdAt: entry.createdAt }];
      }
    } catch {
      // One malformed diagnostic must not poison later valid events or retries.
    }
    return [];
  });
  if (prepared.length === 0) {
    return;
  }
  runOpenClawAgentWriteTransaction((database) => {
    const db = getAcpParentStreamKysely(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("acp_parent_stream_events")
        .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
        .where("session_id", "=", options.sessionId)
        .where("run_id", "=", options.runId),
    );
    const firstSeq =
      row?.max_seq === null || row?.max_seq === undefined
        ? 0
        : normalizeSqliteNumber(row.max_seq) + 1;
    executeSqliteQuerySync(
      database.db,
      db.insertInto("acp_parent_stream_events").values(
        prepared.map((entry, index) => ({
          session_id: options.sessionId,
          run_id: options.runId,
          seq: firstSeq + index,
          event_json: entry.eventJson,
          created_at: entry.createdAt,
        })),
      ),
    );
  }, options);
}
