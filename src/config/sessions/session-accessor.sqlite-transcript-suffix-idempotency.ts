import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventId,
  type SqliteTranscriptStorageRow,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readMessageIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";

export type IncrementalSuffixIdempotencyMutation = {
  suffixIdentityKeys: readonly (readonly [string, string | null])[];
  replacementByIdempotencyKey: readonly (readonly [string, string])[];
};

/** Prepares idempotency-owner changes before the bounded suffix write transaction. */
export function prepareIncrementalSuffixIdempotencyMutation(params: {
  database: OpenClawAgentDatabase;
  expectedRows: readonly SqliteTranscriptStorageRow[];
  next: readonly TranscriptEvent[];
  resolved: ResolvedTranscriptScope;
  startSeq: number;
}): IncrementalSuffixIdempotencyMutation {
  const db = getSessionKysely(params.database.db);
  const suffixIdentityKeys = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "message_idempotency_key"])
      .where("session_id", "=", params.resolved.sessionId)
      .where("seq", ">=", params.startSeq)
      .orderBy("seq", "asc")
      .limit(params.expectedRows.length + 1),
  ).rows.map((row) => [row.event_id, row.message_idempotency_key] as const);
  if (suffixIdentityKeys.length > params.expectedRows.length) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${params.resolved.sessionId}`,
    );
  }
  const suffixIdentityMap = new Map(suffixIdentityKeys);
  const retainedIdempotencyKeys = new Set(
    params.next.flatMap((event) => {
      const eventId = readTranscriptEventId(event);
      const storedKey = eventId ? suffixIdentityMap.get(eventId) : undefined;
      const nextKey = isRecord(event) ? readMessageIdempotencyKey(event.message) : null;
      return storedKey && storedKey === nextKey ? [storedKey] : [];
    }),
  );
  const removedIdempotencyKeys = new Set(
    suffixIdentityKeys.flatMap(([, key]) =>
      key && !retainedIdempotencyKeys.has(key) ? [key] : [],
    ),
  );
  const removedKeys = [...removedIdempotencyKeys];
  if (removedKeys.length === 0) {
    return { suffixIdentityKeys, replacementByIdempotencyKey: [] };
  }
  const trimCharacters =
    " \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const extractedKey =
    /* kysely-allow-raw: select the canonical message idempotency key without hydrating prefix events. */
    sql<string>`CASE
    WHEN json_valid(event.event_json)
      AND json_type(event.event_json, '$.message.idempotencyKey') = 'text'
    THEN trim(json_extract(event.event_json, '$.message.idempotencyKey'), ${trimCharacters})
  END`;
  const replacements = executeSqliteQuerySync(
    params.database.db,
    db
      .with("candidates", (query) =>
        query
          .selectFrom("transcript_event_identities as identity")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "identity.session_id")
              .onRef("event.seq", "=", "identity.seq"),
          )
          .select(["identity.event_id", "identity.seq", extractedKey.as("idempotency_key")])
          .where("identity.session_id", "=", params.resolved.sessionId)
          .where("identity.seq", "<", params.startSeq)
          .where("identity.message_idempotency_key", "is", null)
          .where(extractedKey, "in", removedKeys),
      )
      .with("latest", (query) =>
        query
          .selectFrom("candidates")
          .select([
            "idempotency_key",
            /* kysely-allow-raw: choose the newest retained duplicate as the replacement owner. */
            sql<number>`max(seq)`.as("seq"),
          ])
          .groupBy("idempotency_key"),
      )
      .selectFrom("candidates")
      .innerJoin("latest", (join) =>
        join
          .onRef("latest.idempotency_key", "=", "candidates.idempotency_key")
          .onRef("latest.seq", "=", "candidates.seq"),
      )
      .select(["candidates.event_id", "candidates.idempotency_key"]),
  ).rows;
  return {
    suffixIdentityKeys,
    replacementByIdempotencyKey: replacements.map((row) => [row.idempotency_key, row.event_id]),
  };
}
