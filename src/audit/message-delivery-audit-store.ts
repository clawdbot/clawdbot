/** Read-only owner-native outbound message lifecycle queries for run inspection. */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { AUDIT_EVENT_RETENTION_MS, rowToAuditEvent } from "./audit-event-store.js";
import type { OutboundMessageAuditEventRecord } from "./audit-event-types.js";
import {
  countOutboundMessageProgressForRun,
  hasOutboundMessageProgressCursor,
  readOutboundMessageProgressForRun,
} from "./message-delivery-progress-store.js";

type MessageDeliveryAuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;

function deliveryAuditDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MessageDeliveryAuditDatabase>(db);
}

export type OutboundMessageAuditEventCursor = { occurredAt: number; rowId: number };

type OwnedMessageEvent = {
  event: OutboundMessageAuditEventRecord;
  rowId: number;
};

const MESSAGE_CURSOR_STAGE_SPAN = 1_000_000_000_000;
const MESSAGE_STREAM_CHUNK_SIZE = 256;
type MessageStage = 0 | 1 | 2;
type MessageStream = {
  stage: MessageStage;
  after?: { occurredAt: number; sequence: number };
  buffered: OwnedMessageEvent[];
  exhausted: boolean;
};

function messageStage(event: OutboundMessageAuditEventRecord): MessageStage {
  return event.action === "message.outbound.queued"
    ? 0
    : event.action === "message.outbound.platform-started"
      ? 1
      : 2;
}

function compositeMessageRowId(event: OutboundMessageAuditEventRecord): number {
  if (event.sequence >= MESSAGE_CURSOR_STAGE_SPAN) {
    throw new Error("outbound message decision cursor is outside the supported integer range");
  }
  const rowId = messageStage(event) * MESSAGE_CURSOR_STAGE_SPAN + event.sequence;
  if (!Number.isSafeInteger(rowId)) {
    throw new Error("outbound message decision cursor is outside the supported integer range");
  }
  return rowId;
}

function readTerminalEventsForRun(params: {
  runId: string;
  after?: { occurredAt: number; sequence: number };
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): OutboundMessageAuditEventRecord[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      let query = deliveryAuditDb(db)
        .selectFrom("audit_events")
        .selectAll()
        .where("kind", "=", "message")
        .where("direction", "=", "outbound")
        .where("action", "=", "message.outbound.finished")
        .where("run_id", "=", params.runId)
        .where("occurred_at", ">=", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS);
      const after = params.after;
      if (after) {
        query = query.where((expression) =>
          expression.or([
            expression("occurred_at", ">", after.occurredAt),
            expression.and([
              expression("occurred_at", "=", after.occurredAt),
              expression("sequence", ">", after.sequence),
            ]),
          ]),
        );
      }
      return executeSqliteQuerySync(
        db,
        query.orderBy("occurred_at", "asc").orderBy("sequence", "asc").limit(params.limit),
      ).rows.map(
        // SAFETY: the query fixes the row to the validated outbound terminal-message variant.
        (row) => rowToAuditEvent(row) as OutboundMessageAuditEventRecord,
      );
    }, params.database) ?? []
  );
}

function compareOwnedMessageEvents(left: OwnedMessageEvent, right: OwnedMessageEvent): number {
  return left.event.occurredAt === right.event.occurredAt
    ? left.rowId - right.rowId
    : left.event.occurredAt - right.event.occurredAt;
}

function streamAfterCursor(
  cursor: OutboundMessageAuditEventCursor | undefined,
  stage: MessageStage,
): MessageStream["after"] {
  if (!cursor) {
    return undefined;
  }
  const cursorStage = Math.floor(cursor.rowId / MESSAGE_CURSOR_STAGE_SPAN);
  const cursorSequence = cursor.rowId % MESSAGE_CURSOR_STAGE_SPAN;
  return {
    occurredAt: cursor.occurredAt,
    sequence:
      stage < cursorStage ? Number.MAX_SAFE_INTEGER : stage > cursorStage ? 0 : cursorSequence,
  };
}

function fillMessageStream(
  stream: MessageStream,
  params: { runId: string; now: number; database?: OpenClawStateDatabaseOptions },
): void {
  if (stream.buffered.length > 0 || stream.exhausted) {
    return;
  }
  const query = {
    runId: params.runId,
    now: params.now,
    database: params.database,
    after: stream.after,
    limit: MESSAGE_STREAM_CHUNK_SIZE,
  };
  const events =
    stream.stage === 2
      ? readTerminalEventsForRun(query)
      : readOutboundMessageProgressForRun({
          ...query,
          action:
            stream.stage === 0 ? "message.outbound.queued" : "message.outbound.platform-started",
        });
  stream.buffered = events.map((event) => ({ event, rowId: compositeMessageRowId(event) }));
  stream.exhausted = events.length < MESSAGE_STREAM_CHUNK_SIZE;
  const last = events.at(-1);
  if (last) {
    stream.after = { occurredAt: last.occurredAt, sequence: last.sequence };
  }
}

function takeNextMessageEvent(
  streams: MessageStream[],
  params: { runId: string; now: number; database?: OpenClawStateDatabaseOptions },
): OwnedMessageEvent | undefined {
  for (const stream of streams) {
    fillMessageStream(stream, params);
  }
  let selected: MessageStream | undefined;
  for (const stream of streams) {
    const candidate = stream.buffered[0];
    const current = selected?.buffered[0];
    if (candidate && (!current || compareOwnedMessageEvents(candidate, current) < 0)) {
      selected = stream;
    }
  }
  return selected?.buffered.shift();
}

function hasTerminalCursor(params: {
  runId: string;
  occurredAt: number;
  sequence: number;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        Boolean(
          executeSqliteQueryTakeFirstSync(
            db,
            deliveryAuditDb(db)
              .selectFrom("audit_events")
              .select("sequence")
              .where("sequence", "=", params.sequence)
              .where("run_id", "=", params.runId)
              .where("occurred_at", "=", params.occurredAt)
              .where("kind", "=", "message")
              .where("direction", "=", "outbound")
              .where("action", "=", "message.outbound.finished"),
          ),
        ),
      params.database,
    ) ?? false
  );
}

/** Count retained owner-native outbound lifecycle records for one run. */
export function countOutboundMessageAuditEventsForRun(params: {
  runId: string;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): number {
  return (
    (withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        deliveryAuditDb(db)
          .selectFrom("audit_events")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .where("kind", "=", "message")
          .where("direction", "=", "outbound")
          .where("action", "=", "message.outbound.finished")
          .where("run_id", "=", params.runId)
          .where("occurred_at", ">=", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS),
      );
      return normalizeSqliteNumber(row?.count ?? null) ?? 0;
    }, params.database) ?? 0) + countOutboundMessageProgressForRun(params)
  );
}

/** Page retained owner-native outbound lifecycle records in decision order. */
export function pageOutboundMessageAuditEventsForRun(params: {
  runId: string;
  after?: OutboundMessageAuditEventCursor;
  offset?: number;
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): { events: OutboundMessageAuditEventRecord[]; nextCursor?: OutboundMessageAuditEventCursor } {
  if (params.after) {
    const stage = Math.floor(params.after.rowId / MESSAGE_CURSOR_STAGE_SPAN);
    const sequence = params.after.rowId % MESSAGE_CURSOR_STAGE_SPAN;
    const retained =
      Number.isSafeInteger(sequence) && sequence >= 1 && stage >= 0 && stage <= 2
        ? stage === 2
          ? hasTerminalCursor({
              runId: params.runId,
              occurredAt: params.after.occurredAt,
              sequence,
              database: params.database,
            })
          : hasOutboundMessageProgressCursor({
              runId: params.runId,
              occurredAt: params.after.occurredAt,
              sequence,
              action: stage === 0 ? "message.outbound.queued" : "message.outbound.platform-started",
              database: params.database,
            })
        : false;
    if (!retained) {
      throw new Error("outbound message decision cursor is no longer retained");
    }
  }
  const streams: MessageStream[] = ([0, 1, 2] as const).map((stage) => ({
    stage,
    after: streamAfterCursor(params.after, stage),
    buffered: [],
    exhausted: false,
  }));
  const streamParams = {
    runId: params.runId,
    now: params.now ?? Date.now(),
    database: params.database,
  };
  let remainingOffset = params.offset ?? 0;
  while (remainingOffset > 0 && takeNextMessageEvent(streams, streamParams)) {
    remainingOffset -= 1;
  }
  const rows: OwnedMessageEvent[] = [];
  while (rows.length <= params.limit) {
    const next = takeNextMessageEvent(streams, streamParams);
    if (!next) {
      break;
    }
    rows.push(next);
  }
  const pageRows = rows.slice(0, params.limit);
  const last = pageRows.at(-1);
  return {
    events: pageRows.map((item) => item.event),
    ...(rows.length > params.limit && last
      ? { nextCursor: { occurredAt: last.event.occurredAt, rowId: last.rowId } }
      : {}),
  };
}
