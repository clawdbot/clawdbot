import { redactIdentifier } from "../../logging/redact-identifier.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

export function resolveTranscriptAppendRefusal(
  entry: InternalSessionEntry | undefined,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): TranscriptAppendRefusal | undefined {
  if (
    entry &&
    entry.sessionId === resolved.sessionId &&
    (scope.expectedLifecycleRevision === undefined ||
      entry.lifecycleRevision === scope.expectedLifecycleRevision) &&
    (scope.expectedWriterRunId === undefined ||
      entry.activeWriterRunId === scope.expectedWriterRunId)
  ) {
    return undefined;
  }
  const identity = {
    agentIdHash: redactIdentifier(resolved.agentId),
    expectedSessionIdHash: redactIdentifier(resolved.sessionId),
    sessionKeyHash: redactIdentifier(resolved.sessionKey),
  };
  if (!entry) {
    return { ...identity, code: "session-entry-missing" };
  }
  return {
    ...identity,
    actualSessionIdHash: redactIdentifier(entry.sessionId),
    code: "session-rebound",
  };
}

export function assertLockedTranscriptWriteAllowed(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): void {
  const fencedScope = {
    ...scope,
    sessionId: resolved.sessionId,
    sessionKey: resolved.sessionKey,
  };
  assertOwnedTranscriptWriteCommit(fencedScope);
  if (
    fencedScope.expectedLifecycleRevision === undefined &&
    fencedScope.expectedWriterRunId === undefined
  ) {
    return;
  }
  const fresh = readSessionEntryRow(database, resolved.sessionKey);
  const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
  if (refusal) {
    throw new SessionTranscriptWriterClaimReboundError(refusal);
  }
}
