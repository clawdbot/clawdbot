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

function messageStage(event: OutboundMessageAuditEventRecord): 0 | 1 | 2 {
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
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): OutboundMessageAuditEventRecord[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          deliveryAuditDb(db)
            .selectFrom("audit_events")
            .selectAll()
            .where("kind", "=", "message")
            .where("direction", "=", "outbound")
            .where("action", "=", "message.outbound.finished")
            .where("run_id", "=", params.runId)
            .where("occurred_at", ">=", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS)
            .orderBy("occurred_at", "asc")
            .orderBy("sequence", "asc"),
        ).rows.map((row) => rowToAuditEvent(row) as OutboundMessageAuditEventRecord),
      params.database,
    ) ?? []
  );
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
  const owned: OwnedMessageEvent[] = [
    ...readTerminalEventsForRun(params).map((event) => ({
      event,
      rowId: compositeMessageRowId(event),
    })),
    ...readOutboundMessageProgressForRun(params).map((event) => ({
      event,
      rowId: compositeMessageRowId(event),
    })),
  ].toSorted((left, right) =>
    left.event.occurredAt === right.event.occurredAt
      ? left.rowId - right.rowId
      : left.event.occurredAt - right.event.occurredAt,
  );
  const after = params.after;
  const filtered = after
    ? owned.filter(
        (item) =>
          item.event.occurredAt > after.occurredAt ||
          (item.event.occurredAt === after.occurredAt && item.rowId > after.rowId),
      )
    : owned;
  const offset = params.offset ?? 0;
  const rows = filtered.slice(offset, offset + params.limit + 1);
  const pageRows = rows.slice(0, params.limit);
  const last = pageRows.at(-1);
  return {
    events: pageRows.map((item) => item.event),
    ...(rows.length > params.limit && last
      ? { nextCursor: { occurredAt: last.event.occurredAt, rowId: last.rowId } }
      : {}),
  };
}
