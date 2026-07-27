import type {
  SessionTranscriptRuntimeScope,
  SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionTranscriptRuntimeReadTarget } from "../../config/sessions/session-accessor.js";
import {
  persistTranscriptStateMutation,
  type TranscriptFileState,
  type TranscriptPersistedEntry,
} from "./transcript-file-state.js";

export type RuntimeTranscriptScope = SessionTranscriptRuntimeScope;
type RuntimeTranscriptTarget = SessionTranscriptRuntimeTarget;

/**
 * Resolves the runtime transcript target for read/probe operations without
 * linking missing file-backed metadata into the session store.
 */
export async function resolveRuntimeTranscriptReadTarget(
  scope: RuntimeTranscriptScope,
): Promise<RuntimeTranscriptTarget> {
  return await resolveSessionTranscriptRuntimeReadTarget(scope);
}

/**
 * Persists an append or migration rewrite for a resolved runtime transcript.
 */
export async function persistRuntimeTranscriptStateMutation(params: {
  appendedEntries: TranscriptPersistedEntry[];
  state: TranscriptFileState;
  target: RuntimeTranscriptTarget;
}): Promise<void> {
  await persistTranscriptStateMutation({
    sessionFile: params.target.sessionFile,
    state: params.state,
    appendedEntries: params.appendedEntries,
  });
}
