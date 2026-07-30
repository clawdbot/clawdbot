import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { isSessionTranscriptEventOnActivePath } from "./session-transcript-index.js";

/** Checks one entry against the current active path without materializing that path. */
export function readSessionTranscriptActivePathEntryState(
  scope: SessionTranscriptReadScope,
  entryId: string,
): {
  activeLeafEntryId: string | null;
  entryOnActivePath: boolean;
} {
  return withCurrentProjectionSnapshot(scope, ({ database, resolved, state }) => ({
    activeLeafEntryId: state.leafEventId,
    entryOnActivePath: isSessionTranscriptEventOnActivePath(
      database.db,
      resolved.sessionId,
      entryId,
    ),
  }));
}
