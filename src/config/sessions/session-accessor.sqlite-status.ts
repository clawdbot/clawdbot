import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import {
  hasSqliteSessionOwnerColumns,
  projectSqliteSessionOwner,
  type SqliteSessionOwnerRow,
} from "./session-accessor.sqlite-owner-projection.js";
import {
  hasValidSessionEntryIdentity,
  parseSqliteSessionEntryRecord,
} from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

type SessionStatusDatabase = Pick<OpenClawAgentKyselyDatabase, "session_nodes">;

// Metadata readers do not own prompt snapshots. Strip those bytes before JS allocation;
// Malformed/overdepth JSON reaches the parser unchanged. Requiring an identity keeps
// corrupt prompt-only objects distinct from the retained-window "{}" sentinel.
export const sessionEntryMetadataJson =
  /* kysely-allow-raw: preserve raw-row parsing while omitting unused prompt payloads. */ sql<string>`CASE WHEN json_valid(entry_json)
  THEN CASE WHEN json_type(entry_json, '$.sessionId') = 'text'
    THEN json_remove(entry_json, '$.skillsSnapshot', '$.systemPromptReport')
    ELSE entry_json END
  ELSE entry_json END`.as("entry_json");

export function selectSessionEntryRows(
  database: Pick<OpenClawAgentDatabase, "db">,
  projection: "full" | "list",
) {
  return getNodeSqliteKysely<SessionStatusDatabase>(database.db)
    .selectFrom("session_nodes")
    .select("session_key")
    .select(projection === "full" ? "entry_json" : sessionEntryMetadataJson)
    .$if(hasSqliteSessionOwnerColumns(database.db), (query) =>
      query.select([
        "owner_actor_type",
        "owner_actor_id",
        "owner_assigned_by_type",
        "owner_assigned_by_id",
        "owner_assigned_at",
      ]),
    );
}

// Canonical writers settle entry_valid; raw writes clear it. Inventory readers need
// no payload for settled rows, but must retain parser semantics for pending/retained rows.
export const sessionEntryInventoryJson =
  /* kysely-allow-raw: reuse the writer-owned validity projection without loading saved prompts. */ sql<
    string | null
  >`CASE WHEN entry_valid = 1 THEN NULL ELSE ${sessionEntryMetadataJson.expression} END`.as(
    "entry_json",
  );

export function normalizeStatus(value: unknown): SessionEntryStatus | null {
  return value === "running" ||
    value === "done" ||
    value === "failed" ||
    value === "killed" ||
    value === "timeout"
    ? value
    : null;
}

export { hasValidSessionEntryIdentity };

export function parseSessionEntryJson(
  row: {
    current_session_id?: string;
    entry_json: string;
    updated_at?: number;
  } & SqliteSessionOwnerRow,
  projection: "full" | "list" = "full",
): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  if (!record) {
    return null;
  }
  if (projection === "list") {
    // SQLite-overdepth JSON bypasses SQL projection but must keep the same metadata contract.
    delete record.skillsSnapshot;
    delete record.systemPromptReport;
  }
  return projectSqliteSessionOwner(projectCanonicalSessionEntryShape(record), row);
}

export function readSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  if (selectedStatuses.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db.selectFrom("session_nodes").selectAll().where("status", "in", selectedStatuses);
  if (sessionKeys) {
    query = query.where("session_key", "in", sqliteStringSet(sessionKeys));
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry ? [{ entry, sessionKey: row.session_key }] : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
