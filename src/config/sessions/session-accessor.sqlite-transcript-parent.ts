/** Resolves the effective parent for a transcript message append inside the write transaction. */
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptMessageAppendOptions } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptAppendParentId } from "./session-accessor.sqlite-transcript-store.js";

export function resolveTranscriptMessageAppendParent<TMessage>(
  database: OpenClawAgentDatabase,
  sessionId: string,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "appendIntent" | "parentId">,
): string | null {
  const tailId = readActiveTranscriptAppendParentId(database, sessionId);
  if (options.parentId === undefined) {
    return tailId;
  }
  if (options.appendIntent !== "active-branch" || tailId === options.parentId) {
    return options.parentId;
  }

  const db = getSessionKysely(database.db);
  const countRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select((expression) => expression.fn.countAll<number | bigint>().as("count"))
      .where("session_id", "=", sessionId),
  );
  const maxAncestors = Number(countRow?.count ?? 0);
  let ancestorId: string | null = tailId;
  for (let depth = 0; depth <= maxAncestors; depth += 1) {
    if (ancestorId === options.parentId) {
      // Active appends extend the append-only tree even when their manager snapshot is stale.
      // Rebase only along known ancestry so deliberate branches keep their explicit parent.
      return tailId;
    }
    if (ancestorId === null) {
      break;
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("parent_id")
        .where("session_id", "=", sessionId)
        .where("event_id", "=", ancestorId),
    );
    if (!row) {
      break;
    }
    ancestorId = row.parent_id;
  }
  return options.parentId;
}
