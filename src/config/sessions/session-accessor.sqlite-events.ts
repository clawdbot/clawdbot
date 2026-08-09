import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type {
  SessionLifecycleArchivedTranscript,
  SessionTranscriptWriteScope,
  TranscriptUpdatePayload,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";

// Outward notifications happen only after the owning SQLite mutation commits.

export function emitSessionTranscriptPathUpdates(sessionFiles: readonly string[]): void {
  for (const sessionFile of sessionFiles) {
    emitSessionTranscriptUpdate({ sessionFile });
  }
}

export function emitArchivedTranscriptUpdates(
  archivedTranscripts: readonly SessionLifecycleArchivedTranscript[],
): void {
  emitSessionTranscriptPathUpdates(archivedTranscripts.map((archived) => archived.archivedPath));
}

export async function publishTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
): Promise<void> {
  const resolved = resolveSqliteTranscriptScope(scope);
  emitSessionTranscriptUpdate({
    ...update,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    sessionId: resolved.sessionId,
    target: {
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      sessionKey: resolved.sessionKey,
      storePath: resolved.path,
    },
  });
}
