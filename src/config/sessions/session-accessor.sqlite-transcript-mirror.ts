import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  loadSqliteTranscriptEventsFromDatabase,
  readTranscriptEventMessage,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readMessageIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

// Keep supplied-key probes below SQLite's conservative variable ceiling.
const TRANSCRIPT_MIRROR_KEY_QUERY_BATCH_SIZE = 900;

type TranscriptMirrorFacts = {
  anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
  existingIdempotencyKeys: Set<string>;
  messagesByIdempotencyKey: Map<string, unknown>;
};

/** Returns raw events only when the transcript identity projection is not current. */
function loadTranscriptEventsForMirrorFallback(
  database: OpenClawAgentDatabase,
  sessionId: string,
): TranscriptEvent[] | undefined {
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
  // Raw rows stay authoritative if projection maintenance has not caught up.
  return loadSqliteTranscriptEventsFromDatabase(database, sessionId);
}

/** Reads the bounded identity facts needed by transcript mirrors. */
export function readTranscriptMirrorFacts(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  params: {
    idempotencyKeys: readonly string[];
  },
): TranscriptMirrorFacts {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => readTranscriptMirrorFactsInSnapshot(database, resolved, params),
    {
      databaseLabel: database.path,
      operationLabel: "session.transcript.mirror-facts",
    },
  );
}

/** Reads mirror facts after the caller has established one SQLite snapshot. */
function readTranscriptMirrorFactsInSnapshot(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  params: {
    idempotencyKeys: readonly string[];
  },
): TranscriptMirrorFacts {
  const idempotencyKeys = [...new Set(params.idempotencyKeys)];
  const fallbackEvents = loadTranscriptEventsForMirrorFallback(database, resolved.sessionId);
  if (fallbackEvents !== undefined) {
    return readMirrorFactsFromEvents(fallbackEvents, new Set(idempotencyKeys));
  }

  const db = getSessionKysely(database.db);
  const facts: TranscriptMirrorFacts = {
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
        facts.anchorsByIdempotencyKey.set(idempotencyKey, anchor);
      }
      const message = readTranscriptEventMessage(JSON.parse(row.event_json) as TranscriptEvent);
      if (message !== undefined) {
        facts.messagesByIdempotencyKey.set(idempotencyKey, message);
      }
    }
  }
  return facts;
}

/** Extracts supplied mirror identities from authoritative transcript events. */
function readMirrorFactsFromEvents(
  events: readonly TranscriptEvent[],
  candidateKeys: ReadonlySet<string>,
): TranscriptMirrorFacts {
  const facts: TranscriptMirrorFacts = {
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
  return facts;
}
