/** Resolves the effective parent for a transcript message append inside the write transaction. */
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptMessageAppendOptions } from "./session-accessor.sqlite-contract.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { projectTranscriptNavigationSql } from "./session-model-context-projection.js";
import {
  isSessionTranscriptLeafControl,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
import { resolveVisibleTranscriptAppendParentId } from "./transcript-visible-events.js";

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

function readActiveTranscriptAppendParentId(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | null {
  const db = getSessionKysely(database.db);
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities as ti")
      .innerJoin("transcript_events as te", (join) =>
        join.onRef("te.session_id", "=", "ti.session_id").onRef("te.seq", "=", "ti.seq"),
      )
      .select((eb) => [
        "ti.event_type",
        projectTranscriptNavigationSql(eb.ref("te.event_json")).as("event_json"),
      ])
      .where("ti.session_id", "=", sessionId)
      .orderBy("ti.seq", "desc")
      .limit(1),
  );
  if (!latest) {
    return null;
  }
  const resolveFromNavigation = () =>
    resolveVisibleTranscriptAppendParentId(
      Array.from(
        iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("transcript_events")
            .select((eb) => projectTranscriptNavigationSql(eb.ref("event_json")).as("event_json"))
            .where("session_id", "=", sessionId)
            .orderBy("seq", "asc"),
        ),
        (row) => JSON.parse(row.event_json) as unknown,
      ),
    );
  try {
    const event = JSON.parse(latest.event_json) as unknown;
    const treeEntry = parseSessionTranscriptTreeEntry(event);
    if (!treeEntry) {
      return resolveFromNavigation();
    }
    if (latest.event_type !== "leaf") {
      return treeEntry.appendParentId;
    }
    const leafReferencesKnown =
      treeEntry.leafId !== undefined &&
      transcriptTreeReferenceExists(database, sessionId, treeEntry.leafId) &&
      transcriptTreeReferenceExists(database, sessionId, treeEntry.appendParentId);
    if (isSessionTranscriptLeafControl(event) && leafReferencesKnown) {
      return treeEntry.appendParentId;
    }
  } catch {
    // Fall through to the tolerant full-tree resolver.
  }
  return resolveFromNavigation();
}

function transcriptTreeReferenceExists(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string | null,
): boolean {
  return (
    eventId === null || readTranscriptIdentityByEventId(database, sessionId, eventId) !== undefined
  );
}
