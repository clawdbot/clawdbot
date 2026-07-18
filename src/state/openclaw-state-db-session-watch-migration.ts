// Schema-v4 migration for legacy ambient session-watch sentinel rows.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
  SESSION_WATCH_PROVENANCE_EXPLICIT,
} from "./session-watch-cursor-provenance.js";

const SESSION_WATCH_PROVENANCE_SCHEMA_VERSION = 4;
const LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX = "ambient-group-watch:";
const SESSION_WATCH_PROVENANCE_COLUMN_SQL =
  `provenance TEXT NOT NULL DEFAULT '${SESSION_WATCH_PROVENANCE_EXPLICIT}' ` +
  `CHECK (provenance IN ('${SESSION_WATCH_PROVENANCE_EXPLICIT}', '${SESSION_WATCH_PROVENANCE_AMBIENT_GROUP}'))`;

type SessionWatchCursorDatabase = Pick<OpenClawStateKyselyDatabase, "session_watch_cursors">;

type SessionWatchCursorProvenanceMigrationResult = {
  addedColumn: boolean;
  migratedAmbientWatches: number;
  removedLegacySentinels: number;
};

function getSessionWatchCursorKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionWatchCursorDatabase>(db);
}

function hasLegacyAmbientWatchSentinels(db: DatabaseSync): boolean {
  if (!tableExists(db, "session_watch_cursors")) {
    return false;
  }
  return (
    executeSqliteQueryTakeFirstSync(
      db,
      getSessionWatchCursorKysely(db)
        .selectFrom("session_watch_cursors")
        .select("watcher_session_key")
        .where("watcher_session_key", "like", `${LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX}%`)
        .limit(1),
    ) !== undefined
  );
}

export function needsSessionWatchCursorProvenanceMigration(
  db: DatabaseSync,
  userVersion: number,
): boolean {
  if (!tableExists(db, "session_watch_cursors")) {
    return false;
  }
  return (
    userVersion < SESSION_WATCH_PROVENANCE_SCHEMA_VERSION ||
    !tableHasColumn(db, "session_watch_cursors", "provenance") ||
    hasLegacyAmbientWatchSentinels(db)
  );
}

function decodeLegacyAmbientWatchMarkerKey(markerKey: string): string | undefined {
  const encoded = markerKey.slice(LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  return Buffer.from(encoded, "hex").toString("utf8");
}

export function migrateSessionWatchCursorProvenance(
  db: DatabaseSync,
): SessionWatchCursorProvenanceMigrationResult {
  if (!tableExists(db, "session_watch_cursors")) {
    return { addedColumn: false, migratedAmbientWatches: 0, removedLegacySentinels: 0 };
  }

  const addedColumn = ensureColumn(
    db,
    "session_watch_cursors",
    SESSION_WATCH_PROVENANCE_COLUMN_SQL,
  );
  const kysely = getSessionWatchCursorKysely(db);
  const legacyMarkers = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_watch_cursors")
      .select(["watcher_session_key", "target_session_key", "updated_at"])
      .where("watcher_session_key", "like", `${LEGACY_AMBIENT_GROUP_WATCH_MARKER_PREFIX}%`),
  ).rows;
  let migratedAmbientWatches = 0;
  for (const marker of legacyMarkers) {
    const watcherSessionKey = decodeLegacyAmbientWatchMarkerKey(marker.watcher_session_key);
    if (watcherSessionKey) {
      // Startup and doctor callers hold BEGIN IMMEDIATE across this migration,
      // so the paired timestamp read and update cannot lose a concurrent write.
      const watch = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("session_watch_cursors")
          .select("updated_at")
          .where("watcher_session_key", "=", watcherSessionKey)
          .where("target_session_key", "=", marker.target_session_key),
      );
      if (watch) {
        const promoted = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("session_watch_cursors")
            .set({
              provenance: SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
              updated_at: Math.max(watch.updated_at, marker.updated_at),
            })
            .where("watcher_session_key", "=", watcherSessionKey)
            .where("target_session_key", "=", marker.target_session_key),
        );
        migratedAmbientWatches += Number(promoted.numAffectedRows ?? 0n);
      }
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("session_watch_cursors")
        .where("watcher_session_key", "=", marker.watcher_session_key)
        .where("target_session_key", "=", marker.target_session_key),
    );
  }
  return {
    addedColumn,
    migratedAmbientWatches,
    removedLegacySentinels: legacyMarkers.length,
  };
}
