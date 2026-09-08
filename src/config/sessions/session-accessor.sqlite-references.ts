import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import {
  decodeSqliteTextBytes,
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import {
  isRecentSessionMaintenanceEntry,
  isSessionEntryDiskBudgetEvictable,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

/** Every transcript generation retained by one canonical logical-session record. */
export function collectSessionStateIdsForEntry(entry: SessionEntry): string[] {
  const sessionIds: string[] = [];
  const add = (sessionId: string | undefined) => {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionIds.push(normalized);
    }
  };
  add(entry.sessionId);
  add(entry.previousSessionId);
  for (const sessionId of entry.usageFamilySessionIds ?? []) {
    add(sessionId);
  }
  for (const checkpoint of entry.compactionCheckpoints ?? []) {
    add(checkpoint.sessionId);
    add(checkpoint.preCompaction.sessionId);
    add(checkpoint.postCompaction.sessionId);
  }
  return uniqueStrings(sessionIds);
}

/** Retained logical owners protect generations absent from their entry references. */
export function addRetainedWindowSessionReferences(
  database: OpenClawAgentDatabase,
  sessionIds: Set<string>,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds?: readonly string[],
  diskBudget?: { preserveRecentMs?: number | null },
): void {
  const db = getSessionKysely(database.db);
  // Explicit reset/delete excludes its target owner. Automatic deletion rechecks
  // window ownership inside the commit after archive materialization has awaited.
  let query = db
    .selectFrom("session_windows")
    .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
    .select([
      "session_windows.session_id",
      "session_nodes.session_key",
      "session_nodes.updated_at",
      "session_nodes.pinned_at",
    ])
    .$if(diskBudget !== undefined, (projection) =>
      projection.select(
        /* kysely-allow-raw: preserve exact projected session JSON bytes on affected node:sqlite builds. */ sql<Uint8Array>`CAST(${sessionEntryMetadataJson.expression} AS BLOB)`.as(
          "entry_json_bytes",
        ),
      ),
    )
    .where((eb) =>
      eb.or([
        eb("session_nodes.archived_at", "is not", null),
        eb("session_nodes.pinned_at", "is not", null),
      ]),
    );
  if (candidateSessionIds) {
    query = query.where("session_windows.session_id", "in", sqliteStringSet(candidateSessionIds));
  }
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    if (excludedSessionKeys.has(row.session_key)) {
      continue;
    }
    // Only the physical-budget owner may reclaim cap-created history. Node references
    // (including the current generation) remain protected until its final entry tier.
    if (
      diskBudget &&
      row.pinned_at === null &&
      row.entry_json_bytes !== undefined &&
      isSessionEntryDiskBudgetEvictable({
        key: row.session_key,
        entry:
          parseSessionEntryJson({
            ...row,
            entry_json: decodeSqliteTextBytes(database.db, row.entry_json_bytes),
          }) ?? undefined,
        preserveRecentMs: diskBudget.preserveRecentMs,
      })
    ) {
      continue;
    }
    sessionIds.add(row.session_id);
  }
}

export function isRecentHistoricalSessionId(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  sessionId: string;
}): boolean {
  if (params.preserveRecentMs == null) {
    return false;
  }
  const db = getSessionKysely(params.database.db);
  const row = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
      .select(["session_nodes.session_key", "session_nodes.updated_at"])
      .select([
        /* kysely-allow-raw: preserve exact session identity bytes on affected node:sqlite builds. */ sql<Uint8Array>`CAST(session_nodes.current_session_id AS BLOB)`.as(
          "current_session_id_bytes",
        ),
        /* kysely-allow-raw: preserve exact session JSON bytes on affected node:sqlite builds. */ sql<Uint8Array>`CAST(session_nodes.entry_json AS BLOB)`.as(
          "entry_json_bytes",
        ),
      ])
      .where("session_windows.session_id", "=", params.sessionId),
  ).rows[0];
  if (!row) {
    return false;
  }
  const entry = parseSessionEntryJson({
    ...row,
    current_session_id: decodeSqliteTextBytes(params.database.db, row.current_session_id_bytes),
    entry_json: decodeSqliteTextBytes(params.database.db, row.entry_json_bytes),
  });
  return Boolean(
    entry &&
    isRecentSessionMaintenanceEntry({
      key: row.session_key,
      entry,
      preserveRecentMs: params.preserveRecentMs,
    }),
  );
}
