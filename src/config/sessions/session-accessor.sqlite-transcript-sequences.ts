import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptTurnWriteContext,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-transcript-store.js";

// Append results are public SDK contracts. Keep commit-only cursor metadata
// attached to their object lifetime without changing the returned message shape.
const committedTranscriptMessageSequences = new WeakMap<object, number>();

/** Reads the visible-message sequence captured from the final active branch. */
export function readCommittedSqliteTranscriptMessageSequence(
  message: TranscriptMessageAppendResult<unknown>,
): number | undefined {
  return committedTranscriptMessageSequences.get(message);
}

/** Captures atomic turn cursors from the final projection before SQLite commits. */
export function rememberCommittedSqliteTranscriptMessageSequencesInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): void {
  const appendedMessages = messages.filter((message) => message.appended);
  for (const message of appendedMessages) {
    committedTranscriptMessageSequences.delete(message);
  }
  if (appendedMessages.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<
    Pick<
      OpenClawAgentKyselyDatabase,
      "session_transcript_active_events" | "session_transcript_index_state"
    >
  >(database.db);
  const projection = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_index_state")
      .select("needs_rebuild")
      .where("session_id", "=", sessionId),
  );
  if (projection?.needs_rebuild !== 0) {
    return;
  }
  for (const message of appendedMessages) {
    const identity = readTranscriptIdentityByEventId(database, sessionId, message.messageId);
    if (!identity) {
      continue;
    }
    const active = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_transcript_active_events")
        .select("message_position")
        .where("session_id", "=", sessionId)
        .where("event_seq", "=", identity.seq),
    );
    if (active?.message_position !== null && active?.message_position !== undefined) {
      // Raw event seq includes controls. Client cursors follow the final
      // active-branch message position so abandoned rows cannot leak.
      committedTranscriptMessageSequences.set(message, active.message_position + 1);
    }
  }
}

/** Resolves final cursors while an ordinary turn still owns its writer lock. */
export function rememberCommittedSqliteTranscriptMessageSequences(
  scope: SessionTranscriptTurnWriteContext,
  messages: readonly TranscriptMessageAppendResult<unknown>[],
): void {
  if (!scope.agentId || !scope.sessionId || !scope.sessionKey) {
    return;
  }
  const resolved = resolveSqliteTranscriptScope({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  rememberCommittedSqliteTranscriptMessageSequencesInTransaction(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    resolved.sessionId,
    messages,
  );
}
