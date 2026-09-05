import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
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
      "session_nodes.current_session_id",
      "session_nodes.updated_at",
      "session_nodes.pinned_at",
    ])
    .$if(diskBudget !== undefined, (projection) => projection.select(sessionEntryMetadataJson))
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
      row.entry_json !== undefined &&
      isSessionEntryDiskBudgetEvictable({
        key: row.session_key,
        entry: parseSessionEntryJson({ ...row, entry_json: row.entry_json }) ?? undefined,
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
      .select([
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.session_key",
        "session_nodes.updated_at",
      ])
      .where("session_windows.session_id", "=", params.sessionId),
  ).rows[0];
  if (!row) {
    return false;
  }
  const entry = parseSessionEntryJson(row);
  return Boolean(
    entry &&
    isRecentSessionMaintenanceEntry({
      key: row.session_key,
      entry,
      preserveRecentMs: params.preserveRecentMs,
    }),
  );
}
