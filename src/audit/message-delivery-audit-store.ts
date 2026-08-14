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

type MessageDeliveryAuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;

function deliveryAuditDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MessageDeliveryAuditDatabase>(db);
}

export type OutboundMessageAuditEventCursor = { occurredAt: number; rowId: number };

/** Count retained owner-native outbound lifecycle records for one run. */
export function countOutboundMessageAuditEventsForRun(params: {
  runId: string;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): number {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        deliveryAuditDb(db)
          .selectFrom("audit_events")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .where("kind", "=", "message")
          .where("direction", "=", "outbound")
          .where("run_id", "=", params.runId)
          .where("occurred_at", ">=", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS),
      );
      return normalizeSqliteNumber(row?.count ?? null) ?? 0;
    }, params.database) ?? 0
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
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const kysely = deliveryAuditDb(db);
      const boundary = params.after
        ? executeSqliteQueryTakeFirstSync(
            db,
            kysely
              .selectFrom("audit_events")
              .select(["event_id", "occurred_at"])
              .where("sequence", "=", params.after.rowId)
              .where("run_id", "=", params.runId)
              .where("occurred_at", "=", params.after.occurredAt)
              .where("kind", "=", "message")
              .where("direction", "=", "outbound"),
          )
        : undefined;
      if (params.after && !boundary) {
        throw new Error("outbound message decision cursor is no longer retained");
      }
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("audit_events")
          .selectAll()
          .where("kind", "=", "message")
          .where("direction", "=", "outbound")
          .where("run_id", "=", params.runId)
          .where("occurred_at", ">=", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS)
          .$if(boundary !== undefined, (query) =>
            query.where((eb) =>
              eb.or([
                eb("occurred_at", ">", boundary!.occurred_at),
                eb.and([
                  eb("occurred_at", "=", boundary!.occurred_at),
                  eb("event_id", ">", boundary!.event_id),
                ]),
              ]),
            ),
          )
          .orderBy("occurred_at", "asc")
          .orderBy("event_id", "asc")
          .$if(params.offset !== undefined, (query) => query.offset(params.offset!))
          .limit(params.limit + 1),
      ).rows;
      const pageRows = rows.slice(0, params.limit);
      const events = pageRows.map((row) => rowToAuditEvent(row) as OutboundMessageAuditEventRecord);
      const last = pageRows.at(-1);
      return {
        events,
        ...(rows.length > params.limit && last
          ? {
              nextCursor: {
                occurredAt: normalizeSqliteNumber(last.occurred_at) ?? 0,
                rowId: normalizeSqliteNumber(last.sequence) ?? 0,
              },
            }
          : {}),
      };
    }, params.database) ?? { events: [] }
  );
}
