import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { extractAssistantVisibleText } from "../../shared/chat-message-content.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  LatestTranscriptAssistantMessage,
  LatestTranscriptAssistantText,
  SessionTranscriptReadScope,
  SessionTranscriptEventRow,
  SessionTranscriptStats,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

export type SqliteTranscriptSnapshotRow = {
  eventJson: string;
  seq: number;
};

/** Loads raw transcript events from the additive SQLite transcript store. */
export async function loadSqliteTranscriptEvents(
  scope: SessionTranscriptReadScope,
): Promise<TranscriptEvent[]> {
  return loadSqliteTranscriptEventsSync(scope);
}

/** Loads raw transcript events synchronously from the additive SQLite transcript store. */
export function loadSqliteTranscriptEventsSync(
  scope: SessionTranscriptReadScope,
): TranscriptEvent[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return loadSqliteTranscriptEventsFromDatabase(database, resolved.sessionId);
}

/** Loads additive transcript rows after one durable sequence checkpoint. */
export function loadSqliteTranscriptEventRowsAfterSeqSync(
  scope: SessionTranscriptReadScope,
  afterSeq: number,
  throughSeq?: number,
): SessionTranscriptEventRow[] {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  let query = db
    .selectFrom("transcript_events")
    .select(["event_json", "seq"])
    .where("session_id", "=", resolved.sessionId)
    .where("seq", ">", afterSeq);
  if (throughSeq !== undefined) {
    query = query.where("seq", "<=", throughSeq);
  }
  return executeSqliteQuerySync(database.db, query.orderBy("seq", "asc")).rows.map((row) => ({
    event: JSON.parse(row.event_json) as TranscriptEvent,
    seq: normalizeSqliteNumber(row.seq),
  }));
}

/** Reads one checkpoint row so incremental consumers can reject transcript rewrites. */
export function readSqliteTranscriptEventAtSeqSync(
  scope: SessionTranscriptReadScope,
  seq: number,
): SessionTranscriptEventRow | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", resolved.sessionId)
      .where("seq", "=", seq),
  );
  return row
    ? {
        event: JSON.parse(row.event_json) as TranscriptEvent,
        seq: normalizeSqliteNumber(row.seq),
      }
    : undefined;
}

export function loadSqliteTranscriptEventsFromDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
): TranscriptEvent[] {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent);
}

export function readSqliteTranscriptSnapshot(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { events: TranscriptEvent[]; rows: SqliteTranscriptSnapshotRow[] } {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json", "seq"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return {
    events: rows.map((row) => JSON.parse(row.event_json) as TranscriptEvent),
    rows: rows.map((row) => ({
      eventJson: row.event_json,
      seq: normalizeSqliteNumber(row.seq),
    })),
  };
}

function sqliteTranscriptJsonlByteSize() {
  return /* kysely-allow-raw: JSONL size includes event bytes plus newline separators. */ sql<number>`COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0)
    + CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END`.as("size_bytes");
}

/** Reads transcript freshness and byte size without materializing event rows. */
export function readSqliteTranscriptStatsSync(
  scope: SessionTranscriptReadScope,
): SessionTranscriptStats {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.count<number>("seq").as("event_count"),
        eb.fn.max<number>("seq").as("max_seq"),
        sqliteTranscriptJsonlByteSize(),
      ])
      .where("session_id", "=", resolved.sessionId),
  );
  const session = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("sessions")
      .select(["transcript_observed_at", "transcript_updated_at"])
      .where("session_id", "=", resolved.sessionId),
  );
  return {
    eventCount: row?.event_count ?? 0,
    ...(session?.transcript_updated_at !== null && session?.transcript_updated_at !== undefined
      ? { lastMutationAtMs: session.transcript_updated_at }
      : {}),
    ...(session?.transcript_observed_at !== null && session?.transcript_observed_at !== undefined
      ? { lastObservedMutationAtMs: session.transcript_observed_at }
      : {}),
    maxSeq: row?.max_seq ?? 0,
    sizeBytes: row?.size_bytes ?? 0,
  };
}

export function readTranscriptEventJsonSetInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): Set<string> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("transcript_events").select("event_json").where("session_id", "=", sessionId),
  ).rows;
  return new Set(rows.map((row) => row.event_json));
}

/** Reads the latest visible assistant text from SQLite transcript rows in reverse order. */
export function loadLatestSqliteAssistantText(
  scope: SessionTranscriptReadScope,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantText | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const db = getSessionKysely(database.db);
  const rows = iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events as te")
      .innerJoin("transcript_event_identities as ti", (join) =>
        join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
      )
      .select("te.event_json as event_json")
      .where("te.session_id", "=", resolved.sessionId)
      .where("ti.event_type", "=", "message")
      .orderBy("ti.seq", "desc"),
  );
  for (const row of rows) {
    const latest = parseLatestAssistantMessageEvent(row.event_json, options);
    if (!latest) {
      continue;
    }
    const text = parseLatestAssistantText(latest);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function parseLatestAssistantText(
  latest: LatestTranscriptAssistantMessage,
): LatestTranscriptAssistantText | undefined {
  const message = latest.message as { timestamp?: unknown };
  const text = extractAssistantVisibleText(latest.message)?.trim();
  if (!text) {
    return undefined;
  }
  return {
    ...(latest.id ? { id: latest.id } : {}),
    text,
    ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? { timestamp: message.timestamp }
      : {}),
  };
}

function parseLatestAssistantMessageEvent(
  raw: string,
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
): LatestTranscriptAssistantMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: { model?: unknown; provider?: unknown; role?: unknown; timestamp?: unknown };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}

/** Finds the newest transcript record accepted by the matcher without parsing older rows. */
export function findSqliteTranscriptEvent(
  scope: SessionTranscriptReadScope,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return findSqliteTranscriptEventInDatabase(database, resolved.sessionId, match);
}

export function findSqliteTranscriptEventInDatabase(
  database: OpenClawAgentDatabase,
  sessionId: string,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["event_json"])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc"),
  ).rows;
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as TranscriptEvent;
      if (match(event)) {
        return { event };
      }
    } catch {
      // Malformed rows are skipped, matching transcript index tolerance.
    }
  }
  return undefined;
}

export function readTranscriptEventMessage(
  event: TranscriptEvent,
): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const message = (event as { message?: unknown }).message;
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

export function readTranscriptEventId(event: TranscriptEvent): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const id = (event as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : undefined;
}
