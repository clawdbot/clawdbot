import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
  readTranscriptEventRows,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readMessageIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  resolveVisibleTranscriptAppendParentId,
  selectVisibleTranscriptEventEntries,
} from "./transcript-visible-events.js";

// Keep supplied-key probes below SQLite's conservative variable ceiling.
const TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE = 900;

type TranscriptMirrorFacts = {
  activeAppendParentId: string | null;
  anchorsByEntryId: Map<string, TranscriptEntryAnchor>;
  anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
  existingIdempotencyKeys: Set<string>;
  messagesByIdempotencyKey: Map<string, unknown>;
};

type RawTranscriptEvent = {
  event: TranscriptEvent;
  seq: number;
};

/** Returns raw rows only when the transcript identity projection is not current. */
function loadTranscriptRowsForMirrorFallback(
  database: OpenClawAgentDatabase,
  sessionId: string,
): RawTranscriptEvent[] | undefined {
  const db = getSessionKysely(database.db);
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  if (!latest) {
    return [];
  }
  const state = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_index_state")
      .select(["indexed_seq", "needs_rebuild"])
      .where("session_id", "=", sessionId),
  );
  if (state && state.needs_rebuild === 0 && state.indexed_seq === latest.seq) {
    return undefined;
  }
  // Dirty projection rows are not evidence. Resolve the same raw tree used by
  // projection rebuild without mutating or retrying maintenance from this read.
  return readTranscriptEventRows(database, sessionId).map((row) => ({
    event: JSON.parse(row.eventJson) as TranscriptEvent,
    seq: row.seq,
  }));
}

/** Reads the bounded identity facts needed by transcript mirrors. */
export function readTranscriptMirrorFacts(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  params: {
    entryIds?: readonly string[];
    idempotencyKeys: readonly string[];
  },
): TranscriptMirrorFacts {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => readTranscriptMirrorFactsInTransaction(database, resolved, params),
    {
      databaseLabel: database.path,
      operationLabel: "session.transcript.mirror-facts",
    },
  );
}

/** Reads mirror facts after the caller has established one SQLite snapshot. */
export function readTranscriptMirrorFactsInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  params: {
    entryIds?: readonly string[];
    idempotencyKeys: readonly string[];
  },
): TranscriptMirrorFacts {
  const idempotencyKeys = [...new Set(params.idempotencyKeys)];
  const fallbackRows = loadTranscriptRowsForMirrorFallback(database, resolved.sessionId);
  if (fallbackRows !== undefined) {
    return readMirrorFactsFromRawProjection(
      database,
      resolved,
      fallbackRows,
      new Set(idempotencyKeys),
      new Set(params.entryIds),
    );
  }

  const db = getSessionKysely(database.db);
  const facts: TranscriptMirrorFacts = {
    activeAppendParentId: resolveTranscriptMessageAppendParent(database, resolved.sessionId, {}),
    anchorsByEntryId: new Map(),
    anchorsByIdempotencyKey: new Map(),
    existingIdempotencyKeys: new Set(),
    messagesByIdempotencyKey: new Map(),
  };
  for (
    let offset = 0;
    offset < idempotencyKeys.length;
    offset += TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE
  ) {
    const batch = idempotencyKeys.slice(offset, offset + TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select(["identity.event_id", "identity.message_idempotency_key", "event.event_json"])
        .where("identity.session_id", "=", resolved.sessionId)
        .where("identity.message_idempotency_key", "in", batch)
        .orderBy("identity.seq", "asc"),
    ).rows;
    for (const row of rows) {
      const idempotencyKey = row.message_idempotency_key;
      if (!idempotencyKey) {
        continue;
      }
      facts.existingIdempotencyKeys.add(idempotencyKey);
      const anchor = readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved,
        entryId: row.event_id,
      });
      if (anchor) {
        facts.anchorsByEntryId.set(anchor.entryId, anchor);
        facts.anchorsByIdempotencyKey.set(idempotencyKey, anchor);
      }
      const message = readTranscriptEventMessage(JSON.parse(row.event_json) as TranscriptEvent);
      if (message !== undefined) {
        facts.messagesByIdempotencyKey.set(idempotencyKey, message);
      }
    }
  }
  readRequestedAnchors(database, resolved, params.entryIds, facts);
  return facts;
}

function readRequestedAnchors(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  entryIds: readonly string[] | undefined,
  facts: TranscriptMirrorFacts,
): void {
  for (const entryId of new Set(entryIds)) {
    const anchor = readActiveTranscriptEntryAnchorInTransaction({ database, resolved, entryId });
    if (anchor) {
      facts.anchorsByEntryId.set(entryId, anchor);
    }
  }
}

/** Reconstructs active anchors and topology from authoritative raw transcript rows. */
function readMirrorFactsFromRawProjection(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  rows: readonly RawTranscriptEvent[],
  candidateKeys: ReadonlySet<string>,
  candidateEntryIds: ReadonlySet<string>,
): TranscriptMirrorFacts {
  const events = rows.map((row) => row.event);
  const facts: TranscriptMirrorFacts = {
    activeAppendParentId: resolveVisibleTranscriptAppendParentId(events),
    anchorsByEntryId: new Map(),
    anchorsByIdempotencyKey: new Map(),
    existingIdempotencyKeys: new Set(),
    messagesByIdempotencyKey: new Map(),
  };
  for (const event of events) {
    const message = readTranscriptEventMessage(event);
    const idempotencyKey = readMessageIdempotencyKey(message);
    if (!idempotencyKey || !candidateKeys.has(idempotencyKey)) {
      continue;
    }
    facts.existingIdempotencyKeys.add(idempotencyKey);
    if (message !== undefined) {
      facts.messagesByIdempotencyKey.set(idempotencyKey, message);
    }
  }
  const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
  if (!generation) {
    return facts;
  }
  const rowByEvent = new Map(rows.map((row) => [row.event, row]));
  let activeMessagePosition = 0;
  for (const visible of selectVisibleTranscriptEventEntries(events)) {
    const message = readTranscriptEventMessage(visible.event);
    if (message === undefined) {
      continue;
    }
    const position = activeMessagePosition++;
    const row = rowByEvent.get(visible.event);
    const entryId = readTranscriptEventId(visible.event);
    if (!row || !entryId) {
      continue;
    }
    const idempotencyKey = readMessageIdempotencyKey(message) ?? undefined;
    if (
      !candidateEntryIds.has(entryId) &&
      (!idempotencyKey || !candidateKeys.has(idempotencyKey))
    ) {
      continue;
    }
    const anchor = Object.freeze({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      sessionKey: resolved.sessionKey,
      storePath: database.path,
      generation,
      entryId,
      rawSeq: row.seq,
      effectiveParentId: visible.parentId,
      activeMessagePosition: position,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    facts.anchorsByEntryId.set(entryId, anchor);
    if (idempotencyKey && candidateKeys.has(idempotencyKey)) {
      facts.anchorsByIdempotencyKey.set(idempotencyKey, anchor);
    }
  }
  return facts;
}
