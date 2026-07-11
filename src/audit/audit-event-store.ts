/** SQLite persistence and stable cursor queries for metadata-only audit events. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  AUDIT_EVENT_SCHEMA_VERSION,
  AUDIT_INBOUND_MESSAGE_COMPLETED_REASONS,
  AUDIT_INBOUND_MESSAGE_SKIPPED_REASONS,
  AUDIT_OUTBOUND_MESSAGE_SUPPRESSED_REASONS,
  type AgentRunAuditEventRecord,
  type AuditEventInput,
  type AuditEventListFilters,
  type AuditEventListPage,
  type AuditEventRecord,
  type InboundMessageAuditEventRecord,
  type MessageAuditEventInput,
  type OutboundMessageAuditEventRecord,
  type ToolActionAuditEventRecord,
} from "./audit-event-types.js";
import {
  clearAuditIdentityKeyCacheForDatabase,
  loadOrCreateAuditIdentityKey,
  pseudonymizeAuditIdentity,
} from "./audit-identity.js";

type AuditEventsTable = OpenClawStateKyselyDatabase["audit_events"];
type AuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;
type AuditEventRow = Selectable<AuditEventsTable>;

const AUDIT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_EVENT_MAX_ROWS = 100_000;
const AUDIT_EVENT_PRUNE_BATCH_ROWS = 1_024;
// The single audit writer owns one DB handle. Invalidate on out-of-band
// maintenance or rollback so the hot path avoids a 100k-row scan per message.
const auditEventRowCounts = new WeakMap<DatabaseSync, number>();

function getAuditKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuditDatabase>(db);
}

const RUN_ACTIONS = ["agent.run.started", "agent.run.finished"] as const;
const TOOL_ACTIONS = ["tool.action.started", "tool.action.finished"] as const;
const CONVERSATION_KINDS = ["direct", "group", "channel", "unknown"] as const;
const DELIVERY_KINDS = ["text", "media", "other"] as const;
const FAILURE_STAGES = ["platform_send", "queue", "unknown"] as const;
const AUDIT_HMAC_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

const MESSAGE_COLUMNS = [
  "direction",
  "channel",
  "conversation_kind",
  "message_outcome",
  "reason_code",
  "delivery_kind",
  "failure_stage",
  "duration_ms",
  "result_count",
  "account_ref",
  "conversation_ref",
  "message_ref",
  "target_ref",
] as const satisfies readonly (keyof AuditEventRow)[];

function corruptAuditRow(row: AuditEventRow, problem: string): never {
  const sequence = normalizeSqliteNumber(row.sequence);
  const location = sequence === undefined ? "" : ` ${sequence}`;
  throw new Error(`corrupt audit event row${location}: ${problem}`);
}

function requiredInteger(
  row: AuditEventRow,
  value: number | bigint | null,
  field: string,
  minimum: number,
): number {
  const normalized = normalizeSqliteNumber(value);
  if (normalized === undefined || !Number.isSafeInteger(normalized) || normalized < minimum) {
    corruptAuditRow(row, `invalid ${field}`);
  }
  return normalized;
}

function optionalInteger(
  row: AuditEventRow,
  value: number | bigint | null,
  field: string,
  minimum: number,
): number | undefined {
  if (value === null) {
    return undefined;
  }
  return requiredInteger(row, value, field, minimum);
}

function requiredText(row: AuditEventRow, value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    corruptAuditRow(row, `invalid ${field}`);
  }
  return value;
}

function optionalText(row: AuditEventRow, value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredText(row, value, field);
}

function requiredEnum<const Value extends string>(
  row: AuditEventRow,
  value: unknown,
  field: string,
  allowed: readonly Value[],
): Value {
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  return corruptAuditRow(row, `invalid ${field}`);
}

function optionalEnum<const Value extends string>(
  row: AuditEventRow,
  value: unknown,
  field: string,
  allowed: readonly Value[],
): Value | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredEnum(row, value, field, allowed);
}

function requiredHmacRef(row: AuditEventRow, value: unknown, field: string): string {
  const ref = requiredText(row, value, field);
  if (!AUDIT_HMAC_REF_RE.test(ref)) {
    corruptAuditRow(row, `invalid ${field}`);
  }
  return ref;
}

function optionalHmacRef(row: AuditEventRow, value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredHmacRef(row, value, field);
}

function requireNull(row: AuditEventRow, field: keyof AuditEventRow): void {
  if (row[field] !== null) {
    corruptAuditRow(row, `unexpected ${field}`);
  }
}

function requireNullColumns(row: AuditEventRow, fields: readonly (keyof AuditEventRow)[]): void {
  for (const field of fields) {
    requireNull(row, field);
  }
}

function parseAuditRecordBase(row: AuditEventRow) {
  const schemaVersion = requiredInteger(row, row.schema_version, "schemaVersion", 1);
  if (schemaVersion !== AUDIT_EVENT_SCHEMA_VERSION) {
    corruptAuditRow(row, `unsupported schemaVersion ${schemaVersion}`);
  }
  return {
    schemaVersion,
    sequence: requiredInteger(row, row.sequence, "sequence", 1),
    eventId: requiredText(row, row.event_id, "eventId"),
    sourceSequence: requiredInteger(row, row.source_sequence, "sourceSequence", 1),
    occurredAt: requiredInteger(row, row.occurred_at, "occurredAt", 0),
    redaction: "metadata_only" as const,
  };
}

function parseAgentRecordFields(row: AuditEventRow) {
  requireNullColumns(row, MESSAGE_COLUMNS);
  return {
    ...parseAuditRecordBase(row),
    actorType: requiredEnum(row, row.actor_type, "actorType", ["agent", "system"]),
    actorId: requiredText(row, row.actor_id, "actorId"),
    agentId: requiredText(row, row.agent_id, "agentId"),
    ...(optionalText(row, row.session_key, "sessionKey") !== undefined
      ? { sessionKey: requiredText(row, row.session_key, "sessionKey") }
      : {}),
    ...(optionalText(row, row.session_id, "sessionId") !== undefined
      ? { sessionId: requiredText(row, row.session_id, "sessionId") }
      : {}),
    runId: requiredText(row, row.run_id, "runId"),
  };
}

function parseAgentRunRow(row: AuditEventRow): AgentRunAuditEventRecord {
  requireNull(row, "tool_call_id");
  requireNull(row, "tool_name");
  const common = { ...parseAgentRecordFields(row), kind: "agent_run" as const };
  const action = requiredEnum(row, row.action, "action", RUN_ACTIONS);
  if (action === "agent.run.started") {
    requiredEnum(row, row.status, "status", ["started"]);
    requireNull(row, "error_code");
    return { ...common, action, status: "started" };
  }
  if (row.status === "succeeded") {
    requireNull(row, "error_code");
    return { ...common, action, status: "succeeded" };
  }
  const terminal =
    row.status === "failed"
      ? { status: "failed" as const, errorCode: "run_failed" as const }
      : row.status === "cancelled"
        ? { status: "cancelled" as const, errorCode: "run_cancelled" as const }
        : row.status === "timed_out"
          ? { status: "timed_out" as const, errorCode: "run_timed_out" as const }
          : row.status === "blocked"
            ? { status: "blocked" as const, errorCode: "run_blocked" as const }
            : corruptAuditRow(row, "invalid run terminal status");
  requiredEnum(row, row.error_code, "errorCode", [terminal.errorCode]);
  return { ...common, action, ...terminal };
}

function parseToolActionRow(row: AuditEventRow): ToolActionAuditEventRecord {
  const toolCallId = optionalText(row, row.tool_call_id, "toolCallId");
  const toolName = optionalText(row, row.tool_name, "toolName");
  const common = {
    ...parseAgentRecordFields(row),
    kind: "tool_action" as const,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
  };
  const action = requiredEnum(row, row.action, "action", TOOL_ACTIONS);
  if (action === "tool.action.started") {
    requiredEnum(row, row.status, "status", ["started"]);
    requireNull(row, "error_code");
    return { ...common, action, status: "started" };
  }
  if (row.status === "succeeded") {
    requireNull(row, "error_code");
    return { ...common, action, status: "succeeded" };
  }
  const terminal =
    row.status === "failed"
      ? { status: "failed" as const, errorCode: "tool_failed" as const }
      : row.status === "cancelled"
        ? { status: "cancelled" as const, errorCode: "tool_cancelled" as const }
        : row.status === "timed_out"
          ? { status: "timed_out" as const, errorCode: "tool_timed_out" as const }
          : row.status === "blocked"
            ? { status: "blocked" as const, errorCode: "tool_blocked" as const }
            : row.status === "unknown"
              ? { status: "unknown" as const, errorCode: "tool_outcome_unknown" as const }
              : corruptAuditRow(row, "invalid tool terminal status");
  requiredEnum(row, row.error_code, "errorCode", [terminal.errorCode]);
  return { ...common, action, ...terminal };
}

function parseMessageRecordFields(row: AuditEventRow) {
  requireNullColumns(row, ["session_key", "session_id", "tool_call_id", "tool_name"]);
  const agentId = optionalText(row, row.agent_id, "agentId");
  const runId = optionalText(row, row.run_id, "runId");
  const durationMs = optionalInteger(row, row.duration_ms, "durationMs", 0);
  const resultCount = optionalInteger(row, row.result_count, "resultCount", 0);
  const accountRef = optionalHmacRef(row, row.account_ref, "accountRef");
  const conversationRef = optionalHmacRef(row, row.conversation_ref, "conversationRef");
  const messageRef = optionalHmacRef(row, row.message_ref, "messageRef");
  const targetRef = optionalHmacRef(row, row.target_ref, "targetRef");
  return {
    ...parseAuditRecordBase(row),
    kind: "message" as const,
    channel: requiredText(row, row.channel, "channel"),
    conversationKind: requiredEnum(
      row,
      row.conversation_kind,
      "conversationKind",
      CONVERSATION_KINDS,
    ),
    ...(agentId ? { agentId } : {}),
    ...(runId ? { runId } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(accountRef ? { accountRef } : {}),
    ...(conversationRef ? { conversationRef } : {}),
    ...(messageRef ? { messageRef } : {}),
    ...(targetRef ? { targetRef } : {}),
  };
}

function parseInboundMessageRow(row: AuditEventRow): InboundMessageAuditEventRecord {
  requiredEnum(row, row.action, "action", ["message.inbound.processed"]);
  requiredEnum(row, row.direction, "direction", ["inbound"]);
  requireNull(row, "delivery_kind");
  requireNull(row, "failure_stage");
  const actorType = requiredEnum(row, row.actor_type, "actorType", ["channel_sender", "system"]);
  const actorId =
    actorType === "channel_sender"
      ? requiredHmacRef(row, row.actor_id, "actorId")
      : requiredText(row, row.actor_id, "actorId");
  const common = {
    ...parseMessageRecordFields(row),
    action: "message.inbound.processed" as const,
    direction: "inbound" as const,
    actorType,
    actorId,
  };
  if (row.status === "succeeded") {
    requiredEnum(row, row.message_outcome, "outcome", ["completed"]);
    requireNull(row, "error_code");
    const reasonCode = optionalEnum(
      row,
      row.reason_code,
      "reasonCode",
      AUDIT_INBOUND_MESSAGE_COMPLETED_REASONS,
    );
    return {
      ...common,
      status: "succeeded",
      outcome: "completed",
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  if (row.status === "blocked") {
    requiredEnum(row, row.message_outcome, "outcome", ["skipped"]);
    requireNull(row, "error_code");
    const reasonCode = optionalEnum(
      row,
      row.reason_code,
      "reasonCode",
      AUDIT_INBOUND_MESSAGE_SKIPPED_REASONS,
    );
    return {
      ...common,
      status: "blocked",
      outcome: "skipped",
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  if (row.status === "failed") {
    requiredEnum(row, row.message_outcome, "outcome", ["failed"]);
    requiredEnum(row, row.error_code, "errorCode", ["message_processing_failed"]);
    const reasonCode = optionalEnum(row, row.reason_code, "reasonCode", [
      "acp_dispatch_failed",
      "plugin_bound_error",
    ]);
    return {
      ...common,
      status: "failed",
      outcome: "failed",
      errorCode: "message_processing_failed",
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  return corruptAuditRow(row, "invalid inbound status");
}

function parseOutboundMessageRow(row: AuditEventRow): OutboundMessageAuditEventRecord {
  requiredEnum(row, row.action, "action", ["message.outbound.finished"]);
  requiredEnum(row, row.direction, "direction", ["outbound"]);
  const actorType = requiredEnum(row, row.actor_type, "actorType", ["agent", "system"]);
  const actorId = requiredText(row, row.actor_id, "actorId");
  const commonFields = parseMessageRecordFields(row);
  const common = {
    ...commonFields,
    action: "message.outbound.finished" as const,
    direction: "outbound" as const,
    actorType,
    actorId,
  };
  if (row.status === "succeeded") {
    const deliveryKind = optionalEnum(row, row.delivery_kind, "deliveryKind", DELIVERY_KINDS);
    requiredEnum(row, row.message_outcome, "outcome", ["sent"]);
    requireNullColumns(row, ["error_code", "reason_code", "failure_stage"]);
    return {
      ...common,
      status: "succeeded",
      outcome: "sent",
      ...(deliveryKind ? { deliveryKind } : {}),
    };
  }
  if (row.status === "blocked") {
    requireNull(row, "delivery_kind");
    requiredEnum(row, row.message_outcome, "outcome", ["suppressed"]);
    requireNullColumns(row, ["error_code", "failure_stage"]);
    const reasonCode = requiredEnum(
      row,
      row.reason_code,
      "reasonCode",
      AUDIT_OUTBOUND_MESSAGE_SUPPRESSED_REASONS,
    );
    return {
      ...common,
      status: "blocked",
      outcome: "suppressed",
      reasonCode,
    };
  }
  if (row.status === "failed") {
    const deliveryKind = optionalEnum(row, row.delivery_kind, "deliveryKind", DELIVERY_KINDS);
    requiredEnum(row, row.message_outcome, "outcome", ["failed"]);
    requireNull(row, "reason_code");
    const errorCode = requiredEnum(row, row.error_code, "errorCode", [
      "message_delivery_failed",
      "message_delivery_partial_failure",
    ]);
    const failureStage = requiredEnum(row, row.failure_stage, "failureStage", FAILURE_STAGES);
    return {
      ...common,
      status: "failed",
      outcome: "failed",
      errorCode,
      failureStage,
      ...(deliveryKind ? { deliveryKind } : {}),
    };
  }
  if (row.status === "unknown") {
    requireNull(row, "delivery_kind");
    requiredEnum(row, row.message_outcome, "outcome", ["unknown"]);
    requireNullColumns(row, ["error_code", "reason_code"]);
    const failureStage = requiredEnum(row, row.failure_stage, "failureStage", FAILURE_STAGES);
    return {
      ...common,
      status: "unknown",
      outcome: "unknown",
      failureStage,
    };
  }
  return corruptAuditRow(row, "invalid outbound status");
}

function rowToAuditEvent(row: AuditEventRow): AuditEventRecord {
  if (row.kind === "agent_run") {
    return parseAgentRunRow(row);
  }
  if (row.kind === "tool_action") {
    return parseToolActionRow(row);
  }
  if (row.kind !== "message") {
    corruptAuditRow(row, "invalid kind");
  }
  if (row.direction === "inbound") {
    return parseInboundMessageRow(row);
  }
  if (row.direction === "outbound") {
    return parseOutboundMessageRow(row);
  }
  return corruptAuditRow(row, "invalid message direction");
}

function projectMessageIdentities(db: DatabaseSync, input: MessageAuditEventInput) {
  const identity = loadOrCreateAuditIdentityKey(db);
  const conversationId =
    input.conversationId ?? (input.direction === "outbound" ? input.targetId : undefined);
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
      ...(kind === "message" && conversationId !== undefined ? { conversationId } : {}),
      value,
    });
  return {
    actorId: input.actorType === "channel_sender" ? ref("actor", input.actorId) : input.actorId,
    accountRef: ref("account", input.accountId),
    conversationRef: ref("conversation", conversationId),
    messageRef: ref("message", input.messageId),
    targetRef: ref("target", input.targetId),
  };
}

function bindAuditEvent(db: DatabaseSync, input: AuditEventInput): Insertable<AuditEventsTable> {
  const message = input.kind === "message" ? projectMessageIdentities(db, input) : undefined;
  return {
    event_id: randomUUID(),
    source_id: input.sourceId,
    source_sequence: input.sourceSequence,
    schema_version: AUDIT_EVENT_SCHEMA_VERSION,
    occurred_at: input.occurredAt,
    kind: input.kind,
    action: input.action,
    status: input.status,
    error_code: input.errorCode ?? null,
    actor_type: input.actorType,
    actor_id: message?.actorId ?? input.actorId,
    agent_id: input.agentId ?? null,
    session_key: input.kind === "message" ? null : (input.sessionKey ?? null),
    session_id: input.kind === "message" ? null : (input.sessionId ?? null),
    run_id: input.runId ?? null,
    tool_call_id: input.kind === "tool_action" ? (input.toolCallId ?? null) : null,
    tool_name: input.kind === "tool_action" ? input.toolName : null,
    direction: input.kind === "message" ? input.direction : null,
    channel: input.kind === "message" ? input.channel : null,
    conversation_kind: input.kind === "message" ? input.conversationKind : null,
    message_outcome: input.kind === "message" ? input.outcome : null,
    reason_code: input.kind === "message" ? (input.reasonCode ?? null) : null,
    delivery_kind: input.kind === "message" ? (input.deliveryKind ?? null) : null,
    failure_stage: input.kind === "message" ? (input.failureStage ?? null) : null,
    duration_ms: input.kind === "message" ? (input.durationMs ?? null) : null,
    result_count: input.kind === "message" ? (input.resultCount ?? null) : null,
    account_ref: message?.accountRef ?? null,
    conversation_ref: message?.conversationRef ?? null,
    message_ref: message?.messageRef ?? null,
    target_ref: message?.targetRef ?? null,
  };
}

function countAuditEvents(db: DatabaseSync): number {
  const kysely = getAuditKysely(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_events")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function pruneAuditEventsAfterInsert(
  db: DatabaseSync,
  now: number,
  limits: { maxRows: number; pruneBatchRows: number } = {
    maxRows: AUDIT_EVENT_MAX_ROWS,
    pruneBatchRows: AUDIT_EVENT_PRUNE_BATCH_ROWS,
  },
): void {
  const kysely = getAuditKysely(db);
  const expired = executeSqliteQuerySync(
    db,
    kysely.deleteFrom("audit_events").where("occurred_at", "<", now - AUDIT_EVENT_RETENTION_MS),
  );
  const cachedCount = auditEventRowCounts.get(db);
  let rowCount =
    cachedCount === undefined
      ? countAuditEvents(db)
      : Math.max(0, cachedCount + 1 - Number(expired.numAffectedRows ?? 0n));
  if (rowCount <= limits.maxRows) {
    auditEventRowCounts.set(db, rowCount);
    return;
  }
  const retainedRows = Math.max(0, limits.maxRows - limits.pruneBatchRows);
  const overflowRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_events")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(retainedRows)
      .limit(1),
  );
  const sequenceCutoff = overflowRow ? normalizeSqliteNumber(overflowRow.sequence) : undefined;
  if (sequenceCutoff !== undefined) {
    const pruned = executeSqliteQuerySync(
      db,
      kysely.deleteFrom("audit_events").where("sequence", "<=", sequenceCutoff),
    );
    rowCount = Math.max(0, rowCount - Number(pruned.numAffectedRows ?? 0n));
  }
  auditEventRowCounts.set(db, rowCount);
}

/** Persist one projected event idempotently and prune fixed retention bounds. */
export function recordAuditEvent(
  input: AuditEventInput,
  options: OpenClawStateDatabaseOptions = {},
): AuditEventRecord | undefined {
  let countCacheDatabase: DatabaseSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      countCacheDatabase = db;
      const insert = executeSqliteQuerySync(
        db,
        getAuditKysely(db)
          .insertInto("audit_events")
          .values(bindAuditEvent(db, input))
          .onConflict((conflict) => conflict.column("source_id").doNothing()),
      );
      if (insert.insertId === undefined) {
        return undefined;
      }
      const insertedSequence = Number(insert.insertId);
      if (!Number.isSafeInteger(insertedSequence) || insertedSequence < 1) {
        throw new Error("audit event sequence is outside the supported integer range");
      }
      pruneAuditEventsAfterInsert(db, Date.now());
      const row = executeSqliteQueryTakeFirstSync(
        db,
        getAuditKysely(db)
          .selectFrom("audit_events")
          .selectAll()
          .where("sequence", "=", insertedSequence),
      );
      return row ? rowToAuditEvent(row) : undefined;
    }, options);
  } catch (error) {
    if (countCacheDatabase) {
      auditEventRowCounts.delete(countCacheDatabase);
      clearAuditIdentityKeyCacheForDatabase(countCacheDatabase);
    }
    throw error;
  }
}

/** List newest-first records using a stable sequence cursor. */
export function listAuditEvents(params: {
  filters?: AuditEventListFilters;
  cursor?: number;
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): AuditEventListPage {
  const { db } = openOpenClawStateDatabase(params.database);
  const filters = params.filters ?? {};
  const retainedAfter = (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS;
  let query = getAuditKysely(db)
    .selectFrom("audit_events")
    .selectAll()
    .where("occurred_at", ">=", retainedAfter);
  if (params.cursor !== undefined) {
    query = query.where("sequence", "<", params.cursor);
  }
  if (filters.agentId) {
    query = query.where("agent_id", "=", filters.agentId);
  }
  if (filters.sessionKey) {
    query = query.where("session_key", "=", filters.sessionKey);
  }
  if (filters.runId) {
    query = query.where("run_id", "=", filters.runId);
  }
  if (filters.kind) {
    query = query.where("kind", "=", filters.kind);
  } else if (filters.includeMessages !== true) {
    query = query.where("kind", "!=", "message");
  }
  if (filters.status) {
    query = query.where("status", "=", filters.status);
  }
  if (filters.direction) {
    query = query.where("direction", "=", filters.direction);
  }
  if (filters.channel) {
    query = query.where("channel", "=", filters.channel);
  }
  if (filters.after !== undefined) {
    query = query.where("occurred_at", ">=", filters.after);
  }
  if (filters.before !== undefined) {
    query = query.where("occurred_at", "<=", filters.before);
  }
  const rows = executeSqliteQuerySync(
    db,
    query.orderBy("sequence", "desc").limit(params.limit + 1),
  ).rows;
  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const events = pageRows.map(rowToAuditEvent);
  return {
    events,
    ...(hasMore && events.length > 0 ? { nextCursor: events[events.length - 1]?.sequence } : {}),
  };
}

/** Delete expired metadata during Gateway startup and periodic worker maintenance. */
export function pruneExpiredAuditEvents(
  params: {
    now?: number;
    database?: OpenClawStateDatabaseOptions;
  } = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getAuditKysely(db)
        .deleteFrom("audit_events")
        .where("occurred_at", "<", (params.now ?? Date.now()) - AUDIT_EVENT_RETENTION_MS),
    );
    auditEventRowCounts.delete(db);
  }, params.database);
}

export const auditEventStoreLimits = {
  maxRows: AUDIT_EVENT_MAX_ROWS,
  pruneBatchRows: AUDIT_EVENT_PRUNE_BATCH_ROWS,
  retentionMs: AUDIT_EVENT_RETENTION_MS,
} as const;

export const testApi = { pruneAuditEventsAfterInsert };
