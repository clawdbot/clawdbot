import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  parseSessionEntryJson,
  sessionEntryMetadataJson,
} from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import type { SessionEntry } from "./types.js";

export function collectSqliteSessionMaintenanceBaseKeys(
  store: Record<string, SessionEntry>,
  activeSessionKeys: Iterable<string>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const activeSessionKey of activeSessionKeys) {
    let currentKey = normalizeStoreSessionKey(activeSessionKey);
    while (currentKey && !seen.has(currentKey)) {
      seen.add(currentKey);
      keys.push(currentKey);
      currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
    }
  }
  return keys;
}

export function readSessionMaintenanceKeyProjection(
  database: OpenClawAgentDatabase,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["current_session_id", "parent_session_key", "session_key", "updated_at"])
      .where("archived_at", "is", null)
      .orderBy("session_key", "asc"),
  )) {
    store[row.session_key] = {
      sessionId: row.current_session_id,
      updatedAt: row.updated_at,
      ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
    };
  }
  return store;
}

export function readSessionMaintenanceAgeCandidates(params: {
  database: OpenClawAgentDatabase;
  minimumAgeMs: number | null;
}): Record<string, SessionEntry> {
  if (params.minimumAgeMs == null || params.minimumAgeMs <= 0) {
    return {};
  }
  const db = getSessionKysely(params.database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_nodes")
      .select([sessionEntryMetadataJson, "current_session_id", "session_key", "updated_at"])
      .where("updated_at", "<", Date.now() - params.minimumAgeMs)
      .where("archived_at", "is", null)
      .orderBy("updated_at", "asc"),
  )) {
    const entry = parseSessionEntryJson(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function readSessionMaintenanceCapCandidates(params: {
  database: OpenClawAgentDatabase;
  excludedKeys: ReadonlySet<string>;
}): Record<string, SessionEntry> {
  const db = getSessionKysely(params.database.db);
  const store: Record<string, SessionEntry> = {};
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_nodes")
      .select([sessionEntryMetadataJson, "current_session_id", "session_key", "updated_at"])
      .where("archived_at", "is", null)
      // Stable cap ties previously inherited full-store session-key order.
      .orderBy("session_key", "asc"),
  )) {
    if (params.excludedKeys.has(row.session_key)) {
      continue;
    }
    const entry = parseSessionEntryJson(row);
    if (!entry) {
      continue;
    }
    store[row.session_key] = entry;
  }
  return store;
}
