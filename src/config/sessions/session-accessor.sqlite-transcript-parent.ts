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
import {
  isTranscriptEntryOnVisiblePath,
  resolveVisibleTranscriptAppendParentId,
} from "./transcript-visible-events.js";

export function resolveTranscriptMessageAppendParent<TMessage>(
  database: OpenClawAgentDatabase,
  sessionId: string,
  options: Pick<TranscriptMessageAppendOptions<TMessage>, "appendIntent" | "parentId">,
): string | null {
  const tailId = readActiveTranscriptAppendParentId(database, sessionId);
  if (options.parentId === undefined) {
    return tailId;
  }
  if (options.appendIntent !== "active-branch" || tailId === options.parentId || tailId === null) {
    return options.parentId;
  }

  // Active appends rebase only along known ancestry; deliberate branches keep their parent.
  return transcriptEntryIsAncestor(database, sessionId, tailId, options.parentId)
    ? tailId
    : options.parentId;
}

/** Checks the durable tree directly when the materialized active-path projection is dirty. */
export function isTranscriptEntryOnActivePathInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  entryId: string,
): boolean {
  return isTranscriptEntryOnVisiblePath(
    readTranscriptNavigationEvents(database, sessionId),
    entryId,
  );
}

function transcriptEntryIsAncestor(
  database: OpenClawAgentDatabase,
  sessionId: string,
  leafId: string,
  candidateId: string | null,
): boolean {
  const db = getSessionKysely(database.db);
  // UNION visits each parent once, so cycles terminate without a transcript-wide count.
  // Keep dangling and null parents in the walk: they can be the requested ancestor.
  const ancestor = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .withRecursive("transcript_ancestors", (query) =>
        query
          .selectFrom("transcript_event_identities")
          .select("parent_id")
          .where("session_id", "=", sessionId)
          .where("event_id", "=", leafId)
          .union(
            query
              .selectFrom("transcript_event_identities as ti")
              .innerJoin("transcript_ancestors as ancestor", "ti.event_id", "ancestor.parent_id")
              .select("ti.parent_id")
              .where("ti.session_id", "=", sessionId),
          ),
      )
      .selectFrom("transcript_ancestors")
      .select("parent_id")
      .where("parent_id", candidateId === null ? "is" : "=", candidateId)
      .limit(1),
  );
  return ancestor?.parent_id === candidateId;
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
    resolveVisibleTranscriptAppendParentId(readTranscriptNavigationEvents(database, sessionId));
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

function readTranscriptNavigationEvents(
  database: OpenClawAgentDatabase,
  sessionId: string,
): unknown[] {
  const db = getSessionKysely(database.db);
  return Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select((eb) => projectTranscriptNavigationSql(eb.ref("event_json")).as("event_json"))
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ),
    (row) => JSON.parse(row.event_json) as unknown,
  );
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
