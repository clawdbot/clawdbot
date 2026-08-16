/** Lazy owner-native persistence for nonterminal outbound message progress. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import type {
  OutboundMessageAuditEventRecord,
  OutboundMessageProgressInput,
} from "./audit-event-types.js";
import {
  clearAuditIdentityKeyCacheForDatabase,
  loadOrCreateAuditIdentityKey,
  pseudonymizeAuditIdentity,
} from "./audit-identity.js";

type ProgressTable = OpenClawStateKyselyDatabase["outbound_message_progress"];
type ProgressDatabase = Pick<OpenClawStateKyselyDatabase, "outbound_message_progress">;
type ProgressRow = Selectable<ProgressTable>;

const OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OUTBOUND_MESSAGE_PROGRESS_MAX_ROWS = 200_000;
const OUTBOUND_MESSAGE_PROGRESS_PRUNE_BATCH_ROWS = 1_024;
const AUDIT_HMAC_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;
const ensuredDatabases = new WeakSet<DatabaseSync>();
const progressRowCounts = new WeakMap<DatabaseSync, number>();

function progressSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS outbound_message_progress (",
  );
  const finalIndex = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE INDEX IF NOT EXISTS outbound_message_progress_run_occurred_idx",
    start,
  );
  const end = finalIndex >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(";", finalIndex) : -1;
  if (start < 0 || end < 0) {
    throw new Error("canonical outbound message progress schema is missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 1);
}

function progressDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ProgressDatabase>(db);
}

function ensureProgressSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; progress rows use Kysely.
      db.exec(progressSchemaSql());
    },
    options,
    { operationLabel: "audit.outbound-message-progress.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function projectProgressIdentities(db: DatabaseSync, input: OutboundMessageProgressInput) {
  const identity = loadOrCreateAuditIdentityKey(db);
  const conversationId = input.conversationId ?? input.targetId;
  const ref = (
    kind: Parameters<typeof pseudonymizeAuditIdentity>[0]["kind"],
    value: string | undefined,
  ) =>
    pseudonymizeAuditIdentity({
      identity,
      kind,
      channel: input.channel,
      ...(kind !== "account" && input.accountId !== undefined
        ? { accountId: input.accountId }
        : {}),
      value,
    });
  return {
    accountRef: ref("account", input.accountId),
    conversationRef: ref("conversation", conversationId),
    targetRef: ref("target", input.targetId),
  };
}

function bindProgressRow(
  db: DatabaseSync,
  input: OutboundMessageProgressInput,
): Insertable<ProgressTable> {
  const refs = projectProgressIdentities(db, input);
  return {
    progress_id: randomUUID(),
    source_id: input.sourceId,
    source_sequence: input.sourceSequence,
    schema_version: 1,
    occurred_at: input.occurredAt,
    action: input.action,
    outcome: input.outcome,
    actor_type: input.actorType,
    actor_id: input.actorId,
    agent_id: input.agentId ?? null,
    run_id: input.runId ?? null,
    channel: input.channel,
    conversation_kind: input.conversationKind,
    duration_ms: input.durationMs ?? null,
    account_ref: refs.accountRef ?? null,
    conversation_ref: refs.conversationRef ?? null,
    target_ref: refs.targetRef ?? null,
  };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`corrupt outbound message progress row: invalid ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredText(value, field);
}

function optionalHmacRef(value: unknown, field: string): string | undefined {
  const ref = optionalText(value, field);
  if (ref !== undefined && !AUDIT_HMAC_REF_RE.test(ref)) {
    throw new Error(`corrupt outbound message progress row: invalid ${field}`);
  }
  return ref;
}

function rowToProgressEvent(row: ProgressRow): OutboundMessageAuditEventRecord {
  const sequence = normalizeSqliteNumber(row.sequence);
  const sourceSequence = normalizeSqliteNumber(row.source_sequence);
  const occurredAt = normalizeSqliteNumber(row.occurred_at);
  const durationMs = normalizeSqliteNumber(row.duration_ms);
  if (
    sequence === undefined ||
    sequence < 1 ||
    sourceSequence === undefined ||
    sourceSequence < 1 ||
    occurredAt === undefined ||
    occurredAt < 0 ||
    row.schema_version !== 1 ||
    (durationMs !== undefined && durationMs < 0)
  ) {
    throw new Error("corrupt outbound message progress row: invalid numeric field");
  }
  if (
    (row.action === "message.outbound.queued" && row.outcome !== "queued") ||
    (row.action === "message.outbound.platform-started" && row.outcome !== "platform_started") ||
    (row.action !== "message.outbound.queued" && row.action !== "message.outbound.platform-started")
  ) {
    throw new Error("corrupt outbound message progress row: invalid lifecycle field");
  }
  const actorType =
    row.actor_type === "agent" ? "agent" : row.actor_type === "system" ? "system" : undefined;
  if (!actorType) {
    throw new Error("corrupt outbound message progress row: invalid actor type");
  }
  const conversationKind =
    row.conversation_kind === "direct"
      ? "direct"
      : row.conversation_kind === "group"
        ? "group"
        : row.conversation_kind === "channel"
          ? "channel"
          : row.conversation_kind === "unknown"
            ? "unknown"
            : undefined;
  if (!conversationKind) {
    throw new Error("corrupt outbound message progress row: invalid conversation kind");
  }
  const common = {
    schemaVersion: 1 as const,
    sequence,
    eventId: requiredText(row.progress_id, "progressId"),
    sourceSequence,
    occurredAt,
    redaction: "metadata_only" as const,
    kind: "message" as const,
    actorType,
    actorId: requiredText(row.actor_id, "actorId"),
    ...(optionalText(row.agent_id, "agentId") !== undefined ? { agentId: row.agent_id! } : {}),
    ...(optionalText(row.run_id, "runId") !== undefined ? { runId: row.run_id! } : {}),
    direction: "outbound" as const,
    channel: requiredText(row.channel, "channel"),
    conversationKind,
    ...(durationMs !== undefined ? { durationMs } : {}),
    resultCount: 0,
    ...(optionalHmacRef(row.account_ref, "accountRef") !== undefined
      ? { accountRef: row.account_ref! }
      : {}),
    ...(optionalHmacRef(row.conversation_ref, "conversationRef") !== undefined
      ? { conversationRef: row.conversation_ref! }
      : {}),
    ...(optionalHmacRef(row.target_ref, "targetRef") !== undefined
      ? { targetRef: row.target_ref! }
      : {}),
  } as const;
  return row.action === "message.outbound.queued"
    ? { ...common, action: row.action, status: "started", outcome: "queued" }
    : { ...common, action: row.action, status: "started", outcome: "platform_started" };
}

function countProgressRows(db: DatabaseSync): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    progressDb(db)
      .selectFrom("outbound_message_progress")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function pruneProgressAfterInsert(db: DatabaseSync, now: number): void {
  const kysely = progressDb(db);
  const expired = executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("outbound_message_progress")
      .where("occurred_at", "<", now - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS),
  );
  const cachedCount = progressRowCounts.get(db);
  let rowCount =
    cachedCount === undefined
      ? countProgressRows(db)
      : Math.max(0, cachedCount + 1 - Number(expired.numAffectedRows ?? 0n));
  if (rowCount <= OUTBOUND_MESSAGE_PROGRESS_MAX_ROWS) {
    progressRowCounts.set(db, rowCount);
    return;
  }
  const retainedRows = Math.max(
    0,
    OUTBOUND_MESSAGE_PROGRESS_MAX_ROWS - OUTBOUND_MESSAGE_PROGRESS_PRUNE_BATCH_ROWS,
  );
  const overflow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("outbound_message_progress")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(retainedRows)
      .limit(1),
  );
  const cutoff = overflow ? normalizeSqliteNumber(overflow.sequence) : undefined;
  if (cutoff !== undefined) {
    const pruned = executeSqliteQuerySync(
      db,
      kysely.deleteFrom("outbound_message_progress").where("sequence", "<=", cutoff),
    );
    rowCount = Math.max(0, rowCount - Number(pruned.numAffectedRows ?? 0n));
  }
  progressRowCounts.set(db, rowCount);
}

/** Persist one progress fact idempotently; first use installs only this owner table. */
export function recordOutboundMessageProgress(
  input: OutboundMessageProgressInput,
  options: OpenClawStateDatabaseOptions = {},
): OutboundMessageAuditEventRecord | undefined {
  ensureProgressSchema(options);
  let cacheDatabase: DatabaseSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      cacheDatabase = db;
      const insert = executeSqliteQuerySync(
        db,
        progressDb(db)
          .insertInto("outbound_message_progress")
          .values(bindProgressRow(db, input))
          .onConflict((conflict) => conflict.column("source_id").doNothing()),
      );
      if (insert.insertId === undefined) {
        return undefined;
      }
      const sequence = Number(insert.insertId);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("outbound message progress sequence is outside the supported range");
      }
      pruneProgressAfterInsert(db, Date.now());
      const row = executeSqliteQueryTakeFirstSync(
        db,
        progressDb(db)
          .selectFrom("outbound_message_progress")
          .selectAll()
          .where("sequence", "=", sequence),
      );
      return row ? rowToProgressEvent(row) : undefined;
    }, options);
  } catch (error) {
    if (cacheDatabase) {
      progressRowCounts.delete(cacheDatabase);
      clearAuditIdentityKeyCacheForDatabase(cacheDatabase);
    }
    throw error;
  }
}

export function countOutboundMessageProgressForRun(params: {
  runId: string;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): number {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "outbound_message_progress")) {
        return 0;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        progressDb(db)
          .selectFrom("outbound_message_progress")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .where("run_id", "=", params.runId)
          .where(
            "occurred_at",
            ">=",
            (params.now ?? Date.now()) - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS,
          ),
      );
      return normalizeSqliteNumber(row?.count ?? null) ?? 0;
    }, params.database) ?? 0
  );
}

export function readOutboundMessageProgressForRun(params: {
  runId: string;
  action: OutboundMessageProgressInput["action"];
  after?: { occurredAt: number; sequence: number };
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): OutboundMessageAuditEventRecord[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "outbound_message_progress")) {
        return [];
      }
      let query = progressDb(db)
        .selectFrom("outbound_message_progress")
        .selectAll()
        .where("run_id", "=", params.runId)
        .where("action", "=", params.action)
        .where(
          "occurred_at",
          ">=",
          (params.now ?? Date.now()) - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS,
        );
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
      ).rows.map(rowToProgressEvent);
    }, params.database) ?? []
  );
}

export function hasOutboundMessageProgressCursor(params: {
  runId: string;
  occurredAt: number;
  sequence: number;
  action: OutboundMessageProgressInput["action"];
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "outbound_message_progress")) {
        return false;
      }
      return Boolean(
        executeSqliteQueryTakeFirstSync(
          db,
          progressDb(db)
            .selectFrom("outbound_message_progress")
            .select("sequence")
            .where("sequence", "=", params.sequence)
            .where("run_id", "=", params.runId)
            .where("occurred_at", "=", params.occurredAt)
            .where("action", "=", params.action),
        ),
      );
    }, params.database) ?? false
  );
}

/** Prune existing progress without creating its lazy table. */
export function pruneExpiredOutboundMessageProgress(
  params: { now?: number; database?: OpenClawStateDatabaseOptions } = {},
): void {
  const database = openOpenClawStateDatabase(params.database);
  if (!tableExists(database.db, "outbound_message_progress")) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      progressDb(db)
        .deleteFrom("outbound_message_progress")
        .where(
          "occurred_at",
          "<",
          (params.now ?? Date.now()) - OUTBOUND_MESSAGE_PROGRESS_RETENTION_MS,
        ),
    );
    progressRowCounts.delete(db);
  }, params.database);
}
