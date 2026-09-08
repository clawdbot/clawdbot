import { sql } from "kysely";
import {
  decodeSqliteTextBytes,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  decodeLosslessSessionEntryRow,
  parseSessionEntryJson,
  selectLosslessFullSessionEntryRows,
  sessionEntryInventoryJson,
} from "./session-accessor.sqlite-status.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;

export function readSessionEntryStore(
  database: OpenClawAgentDatabase,
  options: {
    allowCanonicalRepair?: boolean;
    includeArchived?: boolean;
    sessionKeys?: readonly string[];
  } = {},
): Record<string, SessionEntry> {
  if (options.allowCanonicalRepair !== true) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  let query = selectLosslessFullSessionEntryRows(database);
  if (options.includeArchived === false) {
    query = query.where("archived_at", "is", null);
  }
  const rows = iterateSqliteQuerySync(
    database.db,
    (options.sessionKeys
      ? query.where("session_key", "in", sqliteStringSet(options.sessionKeys))
      : query
    ).orderBy("session_key"),
  );
  const store: Record<string, SessionEntry> = {};
  for (const rawRow of rows) {
    const row = decodeLosslessSessionEntryRow(database, rawRow);
    // Doctor lifecycle projection supplies its separately hydrated expected entry for rejected
    // raw rows; ordinary exact reads still fail loud before a write can replace one.
    const entry = parseSessionEntryJson(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function readSessionEntryCount(
  database: OpenClawAgentDatabase,
  options: { includeArchived?: boolean } = {},
): number {
  const db = getSessionKysely(database.db);
  let query = db
    .selectFrom("session_nodes")
    .select(
      /* kysely-allow-raw: preserve exact inventory JSON bytes on affected node:sqlite builds. */ sql<Uint8Array | null>`CAST(${sessionEntryInventoryJson.expression} AS BLOB)`.as(
        "entry_json_bytes",
      ),
    );
  if (options.includeArchived === false) {
    query = query.where("archived_at", "is", null);
  }
  const rows = iterateSqliteQuerySync(database.db, query);
  let count = 0;
  for (const row of rows) {
    const entryJson =
      row.entry_json_bytes === null
        ? null
        : decodeSqliteTextBytes(database.db, row.entry_json_bytes);
    count += entryJson === null || parseSessionEntryJson({ entry_json: entryJson }) ? 1 : 0;
  }
  return count;
}

export function* iterateSessionEntryKeys(
  database: OpenClawAgentDatabaseReader,
): IterableIterator<string> {
  const db = getSessionKysely(database.db);
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select([
        /* kysely-allow-raw: preserve exact inventory JSON bytes on affected node:sqlite builds. */ sql<Uint8Array | null>`CAST(${sessionEntryInventoryJson.expression} AS BLOB)`.as(
          "entry_json_bytes",
        ),
        "session_key",
      ])
      .orderBy("session_key", "asc"),
  )) {
    const entryJson =
      row.entry_json_bytes === null
        ? null
        : decodeSqliteTextBytes(database.db, row.entry_json_bytes);
    if (entryJson === null || parseSessionEntryJson({ entry_json: entryJson })) {
      yield row.session_key;
    }
  }
}
