import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getCliHistoryWriter, isKnownCliHistoryBoundary } from "./cli-history-boundary.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { InternalSessionEntry } from "./types.js";

/** Advance only a contiguous prefix written by the exact prepared CLI account's live owner. */
export function advanceCliHistoryBoundaryInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  seq: number,
): void {
  const target = { ...scope, storePath: database.path };
  const writer = getCliHistoryWriter(target);
  if (!writer) {
    return;
  }
  const entry: InternalSessionEntry | undefined = readSessionEntryRow(
    database,
    scope.sessionKey,
  )?.entry;
  const boundary = entry?.cliHistoryBoundary;
  const generation = readTranscriptGenerationInTransaction(database, scope.sessionId);
  if (
    !entry ||
    !isKnownCliHistoryBoundary(boundary) ||
    entry.sessionId !== scope.sessionId ||
    boundary.sessionId !== scope.sessionId ||
    entry.activeWriterRunId !== writer.expectedWriterRunId ||
    entry.lifecycleRevision !== writer.lifecycleRevision ||
    boundary.writerRunId !== writer.runId ||
    boundary.authFingerprint !== writer.authFingerprint ||
    (boundary.maxSeq === null ? seq !== 0 : boundary.maxSeq !== seq - 1) ||
    !generation ||
    (boundary.generation === null ? seq !== 0 : boundary.generation !== generation)
  ) {
    return;
  }
  writer.assertCurrent();
  writeSessionEntry(
    database,
    scope.sessionKey,
    {
      ...entry,
      cliHistoryBoundary: { ...boundary, generation, maxSeq: seq },
    } satisfies InternalSessionEntry,
    { previousEntry: entry },
  );
}
