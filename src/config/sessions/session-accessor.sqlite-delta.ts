import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import { coerceSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";

const RAW_TRANSCRIPT_CURSOR_VERSION = 1;
const DEFAULT_RAW_TRANSCRIPT_MAX_EVENTS = 1_000;
const DEFAULT_RAW_TRANSCRIPT_MAX_BYTES = 1_000_000;
const MAX_RAW_TRANSCRIPT_EVENTS = 10_000;
const MAX_RAW_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

type RawTranscriptCursor = {
  agentId: string;
  generation: string;
  lastSeq: number;
  sessionId: string;
  version: typeof RAW_TRANSCRIPT_CURSOR_VERSION;
};

type SessionTranscriptRawDeltaPage = Extract<SessionTranscriptRawDeltaResult, { kind: "page" }>;

type ResolvedTranscriptReadScope = ReturnType<typeof resolveSqliteTranscriptReadScope>;

function normalizeRawDeltaLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return resolved;
}

function encodeRawTranscriptCursor(cursor: RawTranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Mint the raw-delta cursor for a generation-consistent transcript snapshot. */
export function createTranscriptRawDeltaCursor(params: {
  agentId: string;
  generation: string;
  lastSeq: number;
  sessionId: string;
}): string {
  return encodeRawTranscriptCursor({ ...params, version: RAW_TRANSCRIPT_CURSOR_VERSION });
}

function parseRawTranscriptCursor(value: string): RawTranscriptCursor | undefined {
  if (value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<RawTranscriptCursor>;
    if (
      parsed.version !== RAW_TRANSCRIPT_CURSOR_VERSION ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "string" ||
      !Number.isSafeInteger(parsed.lastSeq) ||
      (parsed.lastSeq ?? -2) < -1
    ) {
      return undefined;
    }
    return parsed as RawTranscriptCursor;
  } catch {
    return undefined;
  }
}

function bootstrapCursor(
  scope: ResolvedTranscriptReadScope,
  generation: string,
): RawTranscriptCursor {
  return {
    agentId: scope.agentId,
    generation,
    lastSeq: -1,
    sessionId: scope.sessionId,
    version: RAW_TRANSCRIPT_CURSOR_VERSION,
  };
}

/** Read one generation-consistent raw transcript page without parsing excluded payload rows. */
export function readTranscriptRawDelta(
  scope: SessionTranscriptReadScope,
  limits: SessionTranscriptRawDeltaLimits = {},
): SessionTranscriptRawDeltaResult {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const maxEvents = normalizeRawDeltaLimit(
    limits.maxEvents,
    DEFAULT_RAW_TRANSCRIPT_MAX_EVENTS,
    MAX_RAW_TRANSCRIPT_EVENTS,
    "maxEvents",
  );
  const maxBytes = normalizeRawDeltaLimit(
    limits.maxBytes,
    DEFAULT_RAW_TRANSCRIPT_MAX_BYTES,
    MAX_RAW_TRANSCRIPT_BYTES,
    "maxBytes",
  );
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const beforeEventSeq = resolveSqliteSessionTranscriptReadFence({
        database,
        ...resolved,
      })?.beforeRawSeq;
      return readRawDeltaInTransaction(
        database.db,
        resolved,
        limits.cursor,
        maxEvents,
        maxBytes,
        beforeEventSeq,
      );
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript raw delta",
    },
  );
}

function readRawDeltaInTransaction(
  database: import("node:sqlite").DatabaseSync,
  scope: ResolvedTranscriptReadScope,
  encodedCursor: string | undefined,
  maxEvents: number,
  maxBytes: number,
  beforeEventSeq: number | undefined,
): SessionTranscriptRawDeltaResult {
  const db = getSessionKysely(database);
  const state = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", scope.sessionId),
  );
  if (!state) {
    return { kind: "missing" };
  }

  const initialCursor = bootstrapCursor(scope, state.generation);
  const reset = (
    reason: Extract<SessionTranscriptRawDeltaResult, { kind: "reset" }>["reason"],
  ) => ({
    kind: "reset" as const,
    cursor: encodeRawTranscriptCursor(initialCursor),
    reason,
  });
  const cursor =
    encodedCursor !== undefined ? parseRawTranscriptCursor(encodedCursor) : initialCursor;
  if (!cursor) {
    return reset("invalid_cursor");
  }
  if (cursor.agentId !== scope.agentId || cursor.sessionId !== scope.sessionId) {
    return reset("scope_mismatch");
  }
  if (cursor.generation !== state.generation) {
    return reset("generation_mismatch");
  }
  const frontier = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", scope.sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  const maxSeq = Math.min(
    frontier ? coerceSqliteNumber(frontier.seq) : -1,
    beforeEventSeq === undefined ? Number.POSITIVE_INFINITY : beforeEventSeq - 1,
  );
  if (cursor.lastSeq > maxSeq) {
    if (beforeEventSeq !== undefined) {
      throw new SessionTranscriptReadFenceError(
        "Transcript read cursor has crossed the current-turn admission fence",
      );
    }
    return reset("invalid_cursor");
  }

  const metadata = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select([
        "seq",
        /* kysely-allow-raw: SQLite byte length avoids fetching or parsing excluded JSON. */
        sql<number>`OCTET_LENGTH(event_json) + 1`.as("serialized_bytes"),
      ])
      .where("session_id", "=", scope.sessionId)
      .where("seq", ">", cursor.lastSeq)
      .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
      .orderBy("seq", "asc")
      .limit(maxEvents + 1),
  ).rows.map((row) => ({
    seq: coerceSqliteNumber(row.seq),
    serializedBytes: coerceSqliteNumber(row.serialized_bytes),
  }));

  let serializedBytes = 0;
  let selectedCount = 0;
  for (const row of metadata) {
    if (selectedCount >= maxEvents || serializedBytes + row.serializedBytes > maxBytes) {
      break;
    }
    serializedBytes += row.serializedBytes;
    selectedCount += 1;
  }
  const selectedMetadata = metadata.slice(0, selectedCount);
  const lastSeq = selectedMetadata.at(-1)?.seq ?? cursor.lastSeq;
  const rows =
    selectedCount === 0
      ? []
      : executeSqliteQuerySync(
          database,
          db
            .selectFrom("transcript_events")
            .select(["event_json", "seq"])
            .where("session_id", "=", scope.sessionId)
            .where("seq", ">", cursor.lastSeq)
            .where("seq", "<=", lastSeq)
            .orderBy("seq", "asc"),
        ).rows.map((row) => ({
          event: JSON.parse(row.event_json),
          seq: coerceSqliteNumber(row.seq),
        }));
  const nextCursor = encodeRawTranscriptCursor({ ...cursor, lastSeq });
  const requiredBytes =
    selectedCount === 0 && metadata[0] ? metadata[0].serializedBytes : undefined;
  const page: SessionTranscriptRawDeltaPage = {
    kind: "page",
    cursor: nextCursor,
    events: rows,
    hasMore: selectedCount < metadata.length,
    ...(requiredBytes !== undefined ? { requiredBytes } : {}),
    serializedBytes,
  };
  return page;
}
