import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSessionTranscriptGuardState,
  type SessionTranscriptGuardState,
} from "./session-accessor.sqlite-reset-window.js";

/** Reads the canonical logical leaf and optional same-reset-epoch ancestry in one snapshot. */
export function readSessionTranscriptGuardState(
  scope: SessionTranscriptReadScope,
  expectedEntryId?: string,
): SessionTranscriptGuardState {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    resolveSessionTranscriptGuardState(projection, expectedEntryId),
  );
}
