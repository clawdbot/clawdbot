import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";

/** Classifies one entry against the authoritative active path and leaf. */
export function readSessionTranscriptActivePathEntryRelation(
  scope: SessionTranscriptReadScope,
  entryId: string | null,
): "exact" | "ancestor" | "off-path" {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    if (projection.state.leafEventId === entryId || entryId === null) {
      return projection.state.leafEventId === entryId ? "exact" : "off-path";
    }
    const db = getActiveTranscriptKysely(projection.database);
    const row = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("identity.seq")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", entryId)
        .limit(1),
    );
    return row ? "ancestor" : "off-path";
  });
}
