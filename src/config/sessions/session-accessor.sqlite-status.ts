import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryStatus,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import {
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
// malformed or SQLite-overdepth JSON still reaches the existing parser unchanged.
export const sessionEntryMetadataJson =
  /* kysely-allow-raw: preserve raw-row parsing while omitting unused prompt payloads. */ sql<string>`CASE WHEN json_valid(entry_json)
  THEN json_remove(entry_json, '$.skillsSnapshot', '$.systemPromptReport')
  ELSE entry_json END`.as("entry_json");

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
): SessionEntry | null {
  const record = parseSqliteSessionEntryRecord(row);
  return record ? projectSqliteSessionOwner(projectCanonicalSessionEntryShape(record), row) : null;
}

export function readSessionEntriesByStatus(
  database: OpenClawAgentDatabase,
  statuses: readonly SessionEntryStatus[],
  sessionKeys?: readonly string[],
): SessionEntrySummary[] {
  const selectedStatuses = [...new Set(statuses)];
  const selectedSessionKeys = sessionKeys ? [...new Set(sessionKeys)] : undefined;
  if (selectedStatuses.length === 0 || selectedSessionKeys?.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<SessionStatusDatabase>(database.db);
  let query = db.selectFrom("session_nodes").selectAll().where("status", "in", selectedStatuses);
  if (selectedSessionKeys) {
    query = query.where("session_key", "in", selectedSessionKeys);
  }
  return executeSqliteQuerySync(database.db, query)
    .rows.flatMap((row) => {
      const entry = parseSessionEntryJson(row);
      return entry ? [{ entry, sessionKey: row.session_key }] : [];
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
