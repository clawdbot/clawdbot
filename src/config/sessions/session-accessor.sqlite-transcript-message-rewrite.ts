import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

type TranscriptMessageAnchorRewriteResult<TMessage> = {
  generation: string;
  message: TMessage;
};

/** Rewrites one exact anchored message without rejecting unrelated later appends. */
export async function rewriteTranscriptMessageAtAnchor<TMessage>(
  anchor: TranscriptEntryAnchor,
  rewriteMessage: (message: unknown) => TMessage | undefined,
): Promise<TranscriptMessageAnchorRewriteResult<TMessage> | null> {
  const resolved = resolveSqliteTranscriptScope(anchor);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptMessageAnchorRewriteResult<TMessage> | null = null;
    runOpenClawAgentWriteTransaction(
      (database) => {
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("transcript_events")
            .select("event_json")
            .where("session_id", "=", resolved.sessionId)
            .where("seq", "=", anchor.rawSeq),
        );
        if (!row) {
          return;
        }
        const event = JSON.parse(row.event_json) as unknown;
        if (!isRecord(event) || event.type !== "message" || event.id !== anchor.entryId) {
          return;
        }
        const message = rewriteMessage(event.message);
        if (message === undefined) {
          return;
        }
        rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, [
          {
            event: { ...event, message },
            expectedEventJson: row.event_json,
            seq: anchor.rawSeq,
          },
        ]);
        const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
        if (generation) {
          result = { generation, message };
        }
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.message-rewrite" },
    );
    return result;
  });
}
