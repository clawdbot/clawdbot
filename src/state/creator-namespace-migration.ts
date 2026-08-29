import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionActor } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

/** Doctor and versioned upgrades alone may qualify historical creation seams. */
export function migrateLegacySessionCreator(entry: SessionEntry): SessionEntry {
  // SAFETY: Doctor owns retired input; createdBy is checked as a record before it is used.
  const legacy = entry as SessionEntry & { createdBy?: SessionActor };
  const actor =
    entry.createdActor ??
    (isRecord(legacy.createdBy)
      ? { ...legacy.createdBy, type: "human" as const, source: "unknown" as const }
      : undefined);
  if (actor?.type !== "human") {
    return entry;
  }
  const source =
    actor.source === "profile" || actor.source === "channel" || actor.source === "unknown"
      ? actor.source
      : entry.createdVia === "operator" || entry.createdVia === "run"
        ? "profile"
        : entry.createdVia === "channel"
          ? "channel"
          : "unknown";
  if (actor === entry.createdActor && source === actor.source && !legacy.createdBy) {
    return entry;
  }
  const migrated = { ...legacy, createdActor: { ...actor, source } };
  delete migrated.createdBy;
  return migrated;
}

export function migrateSessionCreatorNamespaces(db: DatabaseSync, previousVersion: number): void {
  if (previousVersion >= 19 || !tableExists(db, "session_nodes")) {
    return;
  }
  const update = db.prepare(
    "UPDATE session_nodes SET entry_json = ?, created_actor_type = ?, created_actor_id = ? WHERE session_key = ?",
  );
  const rows = db.prepare(`SELECT session_key, entry_json FROM session_nodes
    WHERE json_valid(entry_json) AND (json_extract(entry_json, '$.createdActor.type') = 'human'
      OR (json_type(entry_json, '$.createdActor') IS NULL AND json_type(entry_json, '$.createdBy') = 'object'))`);
  // SAFETY: The query selects the two declared, non-null TEXT columns without projection casts.
  for (const row of rows.all() as Array<{ session_key: string; entry_json: string }>) {
    // SAFETY: SQL admits valid JSON with a human actor or legacy actor object; all other fields are retained verbatim.
    const entry = migrateLegacySessionCreator(JSON.parse(row.entry_json) as SessionEntry);
    update.run(
      JSON.stringify(entry),
      entry.createdActor?.type ?? null,
      entry.createdActor?.id ?? null,
      row.session_key,
    );
  }
}

/** Historical jobs lost the creator's origin; preserve attribution without guessing authority. */
export function migrateCronCreatorNamespaces(db: DatabaseSync, previousVersion: number): boolean {
  if (previousVersion >= 14 || !tableExists(db, "cron_jobs")) {
    return false;
  }
  db.exec(`
    UPDATE cron_jobs
       SET job_json = json_set(job_json, '$.createdActor.source', 'unknown')
     WHERE json_valid(job_json)
       AND json_extract(job_json, '$.createdActor.type') = 'human';
  `);
  return true;
}
