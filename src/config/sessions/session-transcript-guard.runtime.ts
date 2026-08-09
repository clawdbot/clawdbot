import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import {
  resolveSessionTranscriptGuardState,
  type SessionTranscriptGuardState,
} from "./session-accessor.sqlite-active-boundary.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";

export {
  readRecentSessionTranscriptMessageEventsWithGuard,
  readSessionTranscriptMessageAnchorPageWithGuard,
  readSessionTranscriptMessageEventPageWithGuard,
  readSessionTranscriptMessageEventSnapshotWithGuard,
  type SessionTranscriptMessageAnchorPageWithGuard,
  type SessionTranscriptMessageEventPageWithGuard,
} from "./session-accessor.sqlite-guarded-message-events.js";
export type { SessionTranscriptGuardState };

/** Reads the canonical logical leaf and optional same-reset-epoch ancestry in one snapshot. */
export function readSessionTranscriptGuardState(
  scope: SessionTranscriptReadScope,
  expectedEntryId?: string,
): SessionTranscriptGuardState {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    resolveSessionTranscriptGuardState(projection, expectedEntryId),
  );
}
