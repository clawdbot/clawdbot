/** Durable one-shot registrations for origin-bound sessions_send completion. */
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";

type DeferredCompletionTable = OpenClawStateKyselyDatabase["sessions_send_deferred_completions"];
type DeferredCompletionRow = Selectable<DeferredCompletionTable>;
type DeferredCompletionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "sessions_send_deferred_completions"
>;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const SESSIONS_SEND_DEFERRED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions_send_deferred_completions (
  target_run_id TEXT NOT NULL PRIMARY KEY,
  target_session_key TEXT NOT NULL,
  requester_session_key TEXT NOT NULL,
  requester_session_id TEXT NOT NULL,
  requester_origin_json TEXT NOT NULL,
  request_message TEXT NOT NULL,
  continuation_run_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatching', 'completed', 'cancelled', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER,
  terminal_outcome_json TEXT,
  completion_text TEXT,
  last_error TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_send_deferred_expiry
  ON sessions_send_deferred_completions(state, expires_at, target_run_id);
`;

export type SessionsSendDeferredRegistration = {
  targetRunId: string;
  targetSessionKey: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterOrigin: DeliveryContext;
  requestMessage: string;
  continuationRunId: string;
  createdAt: number;
  expiresAt: number;
};

export type PreparedSessionsSendDeferredRegistration = SessionsSendDeferredRegistration & {
  completionText: string;
};

function getDeferredCompletionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<DeferredCompletionDatabase>(db);
}

function ensureDeferredCompletionSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely below.
      db.exec(SESSIONS_SEND_DEFERRED_SCHEMA_SQL);
    },
    options,
    { operationLabel: "sessions-send.deferred.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function openDeferredCompletionDatabase(options: OpenClawStateDatabaseOptions = {}) {
  ensureDeferredCompletionSchema(options);
  return openOpenClawStateDatabase(options);
}

function parseRegistrationRow(
  row: DeferredCompletionRow | undefined,
): SessionsSendDeferredRegistration | undefined {
  if (!row) {
    return undefined;
  }
  let requesterOrigin: DeliveryContext | undefined;
  try {
    requesterOrigin = normalizeDeliveryContext(
      JSON.parse(row.requester_origin_json) as DeliveryContext,
    );
  } catch {
    return undefined;
  }
  if (!requesterOrigin?.channel || !requesterOrigin.to || !requesterOrigin.accountId) {
    return undefined;
  }
  return {
    targetRunId: row.target_run_id,
    targetSessionKey: row.target_session_key,
    requesterSessionKey: row.requester_session_key,
    requesterSessionId: row.requester_session_id,
    requesterOrigin,
    requestMessage: row.request_message,
    continuationRunId: row.continuation_run_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function parsePreparedRegistrationRow(
  row: DeferredCompletionRow | undefined,
): PreparedSessionsSendDeferredRegistration | undefined {
  const registration = parseRegistrationRow(row);
  if (!registration || !row?.completion_text) {
    return undefined;
  }
  return { ...registration, completionText: row.completion_text };
}

/** Persist a deferred completion registration before its target run is dispatched. */
export function registerSessionsSendDeferredCompletion(
  registration: SessionsSendDeferredRegistration,
  options: OpenClawStateDatabaseOptions = {},
): void {
  ensureDeferredCompletionSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getDeferredCompletionKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("sessions_send_deferred_completions")
          .where("expires_at", "<=", registration.createdAt),
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("sessions_send_deferred_completions").values({
          target_run_id: registration.targetRunId,
          target_session_key: registration.targetSessionKey,
          requester_session_key: registration.requesterSessionKey,
          requester_session_id: registration.requesterSessionId,
          requester_origin_json: JSON.stringify(registration.requesterOrigin),
          request_message: registration.requestMessage,
          continuation_run_id: registration.continuationRunId,
          state: "pending",
          created_at: registration.createdAt,
          expires_at: registration.expiresAt,
        }),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.register" },
  );
}

/** Cancel an unclaimed registration when target dispatch does not start. */
export function cancelSessionsSendDeferredCompletion(
  params: { targetRunId: string; error?: string; now?: number },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const now = params.now ?? Date.now();
  ensureDeferredCompletionSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getDeferredCompletionKysely(db)
          .updateTable("sessions_send_deferred_completions")
          .set({ state: "cancelled", completed_at: now, last_error: params.error ?? null })
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "=", "pending"),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.cancel" },
  );
}

/** Persist target terminal data before the target run is allowed to settle. */
export function prepareSessionsSendDeferredCompletion(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    terminalOutcome: unknown;
    completionText: string;
    now?: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const now = params.now ?? Date.now();
  ensureDeferredCompletionSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getDeferredCompletionKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("sessions_send_deferred_completions")
          .set({ state: "expired", completed_at: now })
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "=", "pending")
          .where("expires_at", "<=", now),
      );
      const prepared = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("sessions_send_deferred_completions")
          .set({
            terminal_outcome_json: JSON.stringify(params.terminalOutcome),
            completion_text: params.completionText,
          })
          .where("target_run_id", "=", params.targetRunId)
          .where("target_session_key", "=", params.targetSessionKey)
          .where("state", "=", "pending")
          .where("completion_text", "is", null)
          .where("expires_at", ">", now),
      );
      return prepared.numAffectedRows === 1n;
    },
    options,
    { operationLabel: "sessions-send.deferred.prepare" },
  );
}

/** Claim prepared work or reopen an interrupted dispatch using its stable idempotency key. */
export function claimSessionsSendDeferredCompletion(
  params: { targetRunId: string; targetSessionKey?: string; now?: number },
  options: OpenClawStateDatabaseOptions = {},
): PreparedSessionsSendDeferredRegistration | undefined {
  const now = params.now ?? Date.now();
  ensureDeferredCompletionSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getDeferredCompletionKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("sessions_send_deferred_completions")
          .set({ state: "expired", completed_at: now })
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "in", ["pending", "dispatching"])
          .where("expires_at", "<=", now),
      );
      let claim = kysely
        .updateTable("sessions_send_deferred_completions")
        .set({ state: "dispatching", claimed_at: now })
        .where("target_run_id", "=", params.targetRunId)
        .where("state", "=", "pending")
        .where("completion_text", "is not", null)
        .where("expires_at", ">", now);
      if (params.targetSessionKey) {
        claim = claim.where("target_session_key", "=", params.targetSessionKey);
      }
      executeSqliteQuerySync(db, claim);

      let select = kysely
        .selectFrom("sessions_send_deferred_completions")
        .selectAll()
        .where("target_run_id", "=", params.targetRunId)
        .where("state", "=", "dispatching")
        .where("completion_text", "is not", null)
        .where("expires_at", ">", now);
      if (params.targetSessionKey) {
        select = select.where("target_session_key", "=", params.targetSessionKey);
      }
      return parsePreparedRegistrationRow(executeSqliteQueryTakeFirstSync(db, select));
    },
    options,
    { operationLabel: "sessions-send.deferred.claim" },
  );
}

/** Record a continuation dispatch result; ambiguous failures remain restart-replayable. */
export function finishSessionsSendDeferredCompletion(
  params: { targetRunId: string; delivered: boolean; error?: string; now?: number },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const now = params.now ?? Date.now();
  ensureDeferredCompletionSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getDeferredCompletionKysely(db)
          .updateTable("sessions_send_deferred_completions")
          .set(
            params.delivered
              ? { state: "completed", completed_at: now, last_error: null }
              : { last_error: params.error ?? "continuation dispatch failed" },
          )
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "=", "dispatching"),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.finish" },
  );
}

/** Retire a dispatch after its continuation user turn becomes durable. */
export function finishSessionsSendDeferredContinuation(
  params: { continuationRunId: string; now?: number },
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  const now = params.now ?? Date.now();
  ensureDeferredCompletionSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getDeferredCompletionKysely(db);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("sessions_send_deferred_completions")
          .select("target_run_id")
          .where("continuation_run_id", "=", params.continuationRunId)
          .where("state", "=", "dispatching"),
      );
      if (!row) {
        return undefined;
      }
      const finished = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("sessions_send_deferred_completions")
          .set({ state: "completed", completed_at: now, last_error: null })
          .where("target_run_id", "=", row.target_run_id)
          .where("continuation_run_id", "=", params.continuationRunId)
          .where("state", "=", "dispatching"),
      );
      return finished.numAffectedRows === 1n ? row.target_run_id : undefined;
    },
    options,
    { operationLabel: "sessions-send.deferred.finish-continuation" },
  );
}

/** List open rows so terminal observers avoid per-run database reads. */
export function listOpenSessionsSendDeferredRunIds(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const { db } = openDeferredCompletionDatabase(options);
  return executeSqliteQuerySync(
    db,
    getDeferredCompletionKysely(db)
      .selectFrom("sessions_send_deferred_completions")
      .select("target_run_id")
      .where("state", "in", ["pending", "dispatching"])
      .where("expires_at", ">", now),
  ).rows.map((row) => row.target_run_id);
}

/** List open continuation ids for the hot transcript-persistence callback. */
export function listOpenSessionsSendDeferredContinuationRunIds(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const { db } = openDeferredCompletionDatabase(options);
  return executeSqliteQuerySync(
    db,
    getDeferredCompletionKysely(db)
      .selectFrom("sessions_send_deferred_completions")
      .select("continuation_run_id")
      .where("state", "in", ["pending", "dispatching"])
      .where("expires_at", ">", now),
  ).rows.map((row) => row.continuation_run_id);
}

/** List prepared pending and interrupted dispatch rows for startup reconciliation. */
export function listDispatchableSessionsSendDeferredRunIds(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const { db } = openDeferredCompletionDatabase(options);
  return executeSqliteQuerySync(
    db,
    getDeferredCompletionKysely(db)
      .selectFrom("sessions_send_deferred_completions")
      .select("target_run_id")
      .where("completion_text", "is not", null)
      .where("state", "in", ["pending", "dispatching"])
      .where("expires_at", ">", now),
  ).rows.map((row) => row.target_run_id);
}
