import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import type { AcpParentStreamEvent } from "./acp-parent-stream-store.sqlite.js";

type AcpParentStreamDatabase = Pick<OpenClawAgentKyselyDatabase, "acp_parent_stream_events">;

export function listAcpParentStreamEventsForTest(
  options: OpenClawAgentDatabaseOptions & { sessionId: string; runId: string },
): AcpParentStreamEvent[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<AcpParentStreamDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("acp_parent_stream_events")
      .select("event_json")
      .where("session_id", "=", options.sessionId)
      .where("run_id", "=", options.runId)
      .orderBy("seq", "asc"),
  ).rows.map((row) => JSON.parse(row.event_json) as AcpParentStreamEvent);
}
