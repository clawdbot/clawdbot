/** Resolves the effective parent for a transcript message append inside the write transaction. */
import { sql } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptMessageAppendOptions } from "./session-accessor.sqlite-contract.js";
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

const PREPARED_ASSISTANT_MAX_NEWER_MESSAGES = 256;
const PREPARED_ASSISTANT_MAX_NEWER_BYTES = 1024 * 1024;
const PREPARED_ASSISTANT_MAX_ANCESTORS = 4096;

/** Validates a prepared assistant from bounded indexed message metadata. */
export function canRebasePreparedAssistantInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  preparedParentId: string | null,
  admittedUserId?: string,
): boolean {
  const tailId = readActiveTranscriptAppendParentId(database, sessionId);
  if (tailId !== preparedParentId) {
    if (
      tailId === null ||
      !transcriptEntryIsAncestor(database, sessionId, tailId, preparedParentId)
    ) {
      return false;
    }
  }
  if (
    admittedUserId &&
    tailId !== admittedUserId &&
    (tailId === null || !transcriptEntryIsAncestor(database, sessionId, tailId, admittedUserId))
  ) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const preparedParent =
    preparedParentId === null
      ? undefined
      : executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities")
            .select("seq")
            .where("session_id", "=", sessionId)
            .where("event_id", "=", preparedParentId)
            .limit(1),
        );
  if (preparedParentId !== null && !preparedParent) {
    return false;
  }
  const admitted = admittedUserId
    ? readTranscriptIdentityInTransaction(database, sessionId, admittedUserId)
    : undefined;
  if (admittedUserId && !admitted) {
    return false;
  }
  const newerMessageMetadata = Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select([
          "identity.event_id",
          "identity.seq",
          /* kysely-allow-raw: bound newer-message validation before hydrating event JSON. */
          sql<number>`OCTET_LENGTH(event.event_json)`.as("serialized_bytes"),
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.event_type", "=", "message")
        .where("identity.seq", ">", preparedParent?.seq ?? -1)
        .orderBy("identity.seq", "asc")
        .limit(PREPARED_ASSISTANT_MAX_NEWER_MESSAGES + 1),
    ),
  );
  if (
    newerMessageMetadata.length > PREPARED_ASSISTANT_MAX_NEWER_MESSAGES ||
    newerMessageMetadata.reduce((sum, row) => sum + row.serialized_bytes, 0) >
      PREPARED_ASSISTANT_MAX_NEWER_BYTES
  ) {
    return false;
  }
  const admittedIsNewer = admitted !== undefined && admitted.seq > (preparedParent?.seq ?? -1);
  if (admittedIsNewer && !newerMessageMetadata.some((row) => row.event_id === admittedUserId)) {
    return false;
  }
  if (newerMessageMetadata.length === 0) {
    return !admittedIsNewer;
  }
  const newerRoles = Array.from(
    iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select([
          "identity.event_id",
          /* kysely-allow-raw: validate the canonical message role without hydrating content. */
          sql<string>`json_extract(event.event_json, '$.message.role')`.as("message_role"),
        ])
        .where("identity.session_id", "=", sessionId)
        .where("identity.seq", ">=", newerMessageMetadata[0]!.seq)
        .where("identity.seq", "<=", newerMessageMetadata.at(-1)!.seq)
        .where("identity.event_type", "=", "message")
        .orderBy("identity.seq", "asc")
        .limit(PREPARED_ASSISTANT_MAX_NEWER_MESSAGES),
    ),
  );
  return newerRoles.every((row) => row.message_role !== "user" || row.event_id === admittedUserId);
}

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
  // Bound ancestry work even for malformed cycles or very deep metadata chains.
  // Keep dangling and null parents in the walk: they can be the requested ancestor.
  const ancestor = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .withRecursive("transcript_ancestors", (query) =>
        query
          .selectFrom("transcript_event_identities")
          .select([
            "parent_id",
            /* kysely-allow-raw: seed the bounded recursive ancestry depth. */
            sql<number>`1`.as("depth"),
          ])
          .where("session_id", "=", sessionId)
          .where("event_id", "=", leafId)
          .unionAll(
            query
              .selectFrom("transcript_event_identities as ti")
              .innerJoin("transcript_ancestors as ancestor", "ti.event_id", "ancestor.parent_id")
              .select([
                "ti.parent_id",
                /* kysely-allow-raw: increment the bounded recursive ancestry depth. */
                sql<number>`ancestor.depth + 1`.as("depth"),
              ])
              .where("ti.session_id", "=", sessionId)
              .where("ancestor.depth", "<", PREPARED_ASSISTANT_MAX_ANCESTORS),
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

function readTranscriptIdentityInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string,
): { eventId: string; parentId: string | null; seq: number } | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "parent_id", "seq"])
      .where("session_id", "=", sessionId)
      .where("event_id", "=", eventId)
      .limit(1),
  );
  return row ? { eventId: row.event_id, parentId: row.parent_id, seq: row.seq } : undefined;
}

function transcriptTreeReferenceExists(
  database: OpenClawAgentDatabase,
  sessionId: string,
  eventId: string | null,
): boolean {
  return (
    eventId === null ||
    readTranscriptIdentityInTransaction(database, sessionId, eventId) !== undefined
  );
}
