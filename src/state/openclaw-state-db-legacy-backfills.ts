import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asFiniteNumber, asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import { selectDeliverableSessionsReply } from "../agents/tools/sessions-send-tokens.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { compactLegacyDeliveryQueueFailures } from "./openclaw-state-db-delivery-queue-backfill.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export function ensureOperatorApprovalResolutionRefs(db: DatabaseSync): void {
  if (!tableExists(db, "operator_approvals")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    ensureColumn(db, "operator_approvals", "resolution_ref TEXT");
    const rows = db
      .prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals")
      .all() as Array<{
      approval_id?: unknown;
      kind?: unknown;
      resolution_ref?: unknown;
    }>;
    const update = db.prepare(
      "UPDATE operator_approvals SET resolution_ref = ? WHERE approval_id = ?",
    );
    for (const row of rows) {
      if (
        typeof row.approval_id !== "string" ||
        !operatorApprovalMigration.isCanonicalOperatorApprovalKind(row.kind)
      ) {
        throw new Error("operator approval row cannot be assigned a transport reference");
      }
      const resolutionRef = buildApprovalResolutionRef({
        approvalId: row.approval_id,
        approvalKind: row.kind,
      });
      if (row.resolution_ref !== resolutionRef) {
        update.run(resolutionRef, row.approval_id);
      }
    }
    const namespaceConflict = db
      .prepare(
        `SELECT canonical.approval_id
         FROM operator_approvals AS canonical
         JOIN operator_approvals AS referenced
           ON canonical.approval_id = referenced.resolution_ref
         WHERE canonical.approval_id <> referenced.approval_id
         LIMIT 1`,
      )
      .get();
    if (namespaceConflict) {
      throw new Error("operator approval ids conflict with durable transport references");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_approvals_resolution_ref
        ON operator_approvals(resolution_ref);
    `);
  });
}

export function repairLegacyTaskAgentAttribution(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs") || !tableHasColumn(db, "task_runs", "requester_agent_id")) {
    return;
  }
  // Before requester_agent_id existed, scoped subagent/ACP rows stored the
  // requester in agent_id. Repair only rows with recoverable requester
  // provenance; global legacy rows must keep the existing fallback behavior.
  db.exec(`
    UPDATE task_runs
    SET
      requester_agent_id = CASE
        WHEN owner_key GLOB 'agent:*:*' THEN substr(
          owner_key,
          7,
          instr(substr(owner_key, 7), ':') - 1
        )
        WHEN requester_session_key GLOB 'agent:*:*' THEN substr(
          requester_session_key,
          7,
          instr(substr(requester_session_key, 7), ':') - 1
        )
        WHEN agent_id <> substr(
          child_session_key,
          7,
          instr(substr(child_session_key, 7), ':') - 1
        ) THEN agent_id
        ELSE NULL
      END,
      agent_id = substr(
        child_session_key,
        7,
        instr(substr(child_session_key, 7), ':') - 1
      )
    WHERE requester_agent_id IS NULL
      AND runtime IN ('subagent', 'acp')
      AND child_session_key GLOB 'agent:*:*'
      AND instr(substr(child_session_key, 7), ':') > 1
      AND (
        owner_key GLOB 'agent:*:*'
        OR requester_session_key GLOB 'agent:*:*'
        OR (
          agent_id IS NOT NULL
          AND agent_id <> substr(
            child_session_key,
            7,
            instr(substr(child_session_key, 7), ':') - 1
          )
        )
      );
  `);
}

export function repairLegacyTaskDeliveryStatuses(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs") || !tableHasColumn(db, "task_runs", "delivery_status")) {
    return;
  }
  // Successful sidecar imports archive their source, so database open must
  // also canonicalize rows already copied by released migrations.
  db.exec(`
    UPDATE task_runs
    SET delivery_status = 'not_applicable'
    WHERE delivery_status = 'not-requested';
  `);
}

type LegacyRetainedResultRow = {
  run_id: string;
  payload_json: string;
  pending_final_delivery_payload_json?: string | null;
};

function nullableTextValue(record: Record<string, unknown> | null, key: string) {
  if (!record || !Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" || value === null ? value : undefined;
}

function selectLegacyRetainedTaskResult(
  completion: Record<string, unknown>,
  primary: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  const terminalReply = normalizeAgentRunTerminalReplySnapshot(completion.terminalReply);
  if (terminalReply) {
    return terminalReply.disposition === "visible" ? terminalReply.text : null;
  }
  return selectDeliverableSessionsReply(primary, fallback) ?? null;
}

/** Promote shipped retained results before runtime hydrates canonical subagent/task state. */
export function repairLegacySubagentRetainedResults(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  const repair = () => {
    const hasLegacyPendingPayload = tableHasColumn(
      db,
      "subagent_runs",
      "pending_final_delivery_payload_json",
    );
    const rows = db
      .prepare(
        hasLegacyPendingPayload
          ? "SELECT run_id, payload_json, pending_final_delivery_payload_json FROM subagent_runs"
          : "SELECT run_id, payload_json FROM subagent_runs",
      )
      .all() as LegacyRetainedResultRow[];
    const updateRun = db.prepare(
      `UPDATE subagent_runs
          SET payload_json = ?
        WHERE run_id = ?`,
    );
    const canProjectTasks =
      tableExists(db, "task_runs") && tableHasColumn(db, "task_runs", "progress_summary");
    const updateTask = canProjectTasks
      ? db.prepare(
          `UPDATE task_runs
              SET progress_summary = ?
            WHERE runtime = 'subagent'
              AND run_id = ?
              AND (progress_summary IS NULL
                OR trim(progress_summary) = ''
                OR (? IS NOT NULL AND trim(progress_summary) = ?))`,
        )
      : undefined;

    for (const row of rows) {
      const payload = parseJsonRecord(row.payload_json);
      const completion = payload ? recordField(payload, "completion") : null;
      if (!payload || !completion) {
        continue;
      }
      const delivery = recordField(payload, "delivery");
      const deliveryPayload = delivery ? recordField(delivery, "payload") : null;
      const pendingPayload = row.pending_final_delivery_payload_json
        ? parseJsonRecord(row.pending_final_delivery_payload_json)
        : null;
      const hasLegacyResult = Boolean(
        (deliveryPayload &&
          (Object.hasOwn(deliveryPayload, "frozenResultText") ||
            Object.hasOwn(deliveryPayload, "fallbackFrozenResultText"))) ||
        (pendingPayload &&
          (Object.hasOwn(pendingPayload, "frozenResultText") ||
            Object.hasOwn(pendingPayload, "fallbackFrozenResultText"))),
      );
      if (!hasLegacyResult) {
        continue;
      }
      const legacyPrimary =
        nullableTextValue(deliveryPayload, "frozenResultText") ??
        nullableTextValue(pendingPayload, "frozenResultText");
      const legacyFallback =
        nullableTextValue(deliveryPayload, "fallbackFrozenResultText") ??
        nullableTextValue(pendingPayload, "fallbackFrozenResultText");
      if (nullableTextValue(completion, "resultText") == null && legacyPrimary !== undefined) {
        completion.resultText = legacyPrimary;
      }
      if (
        nullableTextValue(completion, "fallbackResultText") == null &&
        legacyFallback !== undefined
      ) {
        completion.fallbackResultText = legacyFallback;
      }
      delete deliveryPayload?.frozenResultText;
      delete deliveryPayload?.fallbackFrozenResultText;
      const primary = nullableTextValue(completion, "resultText");
      const fallback = nullableTextValue(completion, "fallbackResultText");
      updateRun.run(JSON.stringify(payload), row.run_id);
      const taskRunId = textField(payload, "taskRunId") ?? row.run_id;
      const terminalReply = normalizeAgentRunTerminalReplySnapshot(completion.terminalReply);
      const taskResult = selectLegacyRetainedTaskResult(completion, primary, fallback);
      if (updateTask && (taskResult || terminalReply)) {
        const retainedPrimary = primary?.trim() || null;
        updateTask.run(taskResult, taskRunId, retainedPrimary, retainedPrimary);
      }
    }
  };
  if (db.isTransaction) {
    repair();
    return;
  }
  runSqliteImmediateTransactionSync(db, repair);
}

/** Canonicalize shipped subagent rows whose pause/kill owner only wrote root terminal fields. */
export function repairLegacySubagentExecutionPayloads(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  db.exec(`
    UPDATE subagent_runs
    SET payload_json = json_remove(
      CASE
        WHEN json_extract(payload_json, '$.pauseReason') = 'sessions_yield'
          AND json_extract(payload_json, '$.execution.status') <> 'terminal'
          AND json_type(payload_json, '$.endedAt') IN ('integer', 'real')
        THEN json_remove(json_set(
          payload_json,
          '$.execution.status', 'terminal',
          '$.execution.endedAt', json_extract(payload_json, '$.endedAt')
        ), '$.execution.outcome')
        WHEN (json_type(payload_json, '$.killReconciliation') = 'object'
          OR json_extract(payload_json, '$.endedReason') = 'subagent-killed')
          AND json_extract(payload_json, '$.execution.status') <> 'terminal'
          AND json_type(payload_json, '$.endedAt') IN ('integer', 'real')
          AND json_type(payload_json, '$.outcome') = 'object'
        THEN json_set(
          payload_json,
          '$.execution.status', 'terminal',
          '$.execution.endedAt', json_extract(payload_json, '$.endedAt'),
          '$.execution.outcome', json_extract(payload_json, '$.outcome')
        )
        ELSE payload_json
      END,
      '$.startedAt', '$.endedAt', '$.outcome'
    )
    WHERE json_valid(payload_json)
      AND (json_type(payload_json, '$.startedAt') IS NOT NULL
        OR json_type(payload_json, '$.endedAt') IS NOT NULL
        OR json_type(payload_json, '$.outcome') IS NOT NULL);
  `);
}

/** Canonicalize the shipped suspension reason before runtime hydrates subagent state. */
export function repairLegacySubagentSuspensionReasons(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  // v2026.6.34 persisted retry-limit; remove this backfill after its 7-day retention window.
  db.exec(`
    UPDATE subagent_runs
    SET payload_json = json_set(payload_json, '$.delivery.suspendedReason', 'permanent_failure')
    WHERE json_valid(payload_json)
      AND json_extract(payload_json, '$.delivery.suspendedReason') = 'retry-limit';
  `);
}

export function backfillAcpReplayEstimatedBytes(db: DatabaseSync): void {
  if (
    !tableExists(db, "acp_replay_events") ||
    !tableHasColumn(db, "acp_replay_events", "estimated_bytes")
  ) {
    return;
  }
  const pendingEvent = db
    .prepare("SELECT 1 FROM acp_replay_events WHERE estimated_bytes = 0 LIMIT 1")
    .get();
  const pendingSession = db
    .prepare("SELECT 1 FROM acp_replay_sessions WHERE estimated_bytes = 0 LIMIT 1")
    .get();
  if (!pendingEvent && !pendingSession) {
    return;
  }
  db.exec(`
    UPDATE acp_replay_events
       SET estimated_bytes = length(session_id) + length(session_key) + length(update_json)
             + COALESCE(length(run_id), 0) + 32
     WHERE estimated_bytes = 0;
    UPDATE acp_replay_sessions
       SET estimated_bytes = length(session_id) + length(session_key) + length(cwd) + 32
             + COALESCE((SELECT SUM(e.estimated_bytes) FROM acp_replay_events e
                          WHERE e.session_id = acp_replay_sessions.session_id), 0)
     WHERE estimated_bytes = 0;
  `);
}

export function backfillCronRunLogEntryJson(db: DatabaseSync): void {
  if (!tableExists(db, "cron_run_logs") || !tableHasColumn(db, "cron_run_logs", "entry_json")) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, seq, ts
         FROM cron_run_logs
        WHERE entry_json = '{}'`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    seq: number | bigint;
    ts: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_run_logs
        SET entry_json = ?
      WHERE store_key = ? AND job_id = ? AND seq = ?`,
  );
  for (const row of rows) {
    update.run(
      JSON.stringify({ ts: Number(row.ts), jobId: row.job_id, action: "finished" }),
      row.store_key,
      row.job_id,
      row.seq,
    );
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  return safeParseJsonRecord(value) ?? null;
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return asFiniteNumber(record[key]) ?? null;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asNullableRecord(record[key]);
}

export function backfillCronJobsFromJobJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "cron_jobs") ||
    !tableHasColumn(db, "cron_jobs", "job_json") ||
    !tableHasColumn(db, "cron_jobs", "payload_kind")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, updated_at
         FROM cron_jobs
        WHERE payload_kind = 'message'
           OR name = ''`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    updated_at: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_jobs
        SET name = ?,
            enabled = ?,
            agent_id = ?,
            payload_kind = ?,
            runtime_updated_at_ms = ?
      WHERE store_key = ?
        AND job_id = ?`,
  );
  for (const row of rows) {
    const job = parseJsonRecord(row.job_json);
    if (!job) {
      continue;
    }
    // Legacy defaults are repaired only in the query-bearing projection; job_json owns config.
    const schedule = recordField(job, "schedule");
    const payload = recordField(job, "payload");
    const scheduleKind = textField(schedule ?? {}, "kind");
    const payloadKind = textField(payload ?? {}, "kind");
    const isAt = scheduleKind === "at" && textField(schedule ?? {}, "at");
    const isEvery = scheduleKind === "every" && numberField(schedule ?? {}, "everyMs") != null;
    const isCron = scheduleKind === "cron" && textField(schedule ?? {}, "expr");
    const isSystemEvent = payloadKind === "systemEvent" && textField(payload ?? {}, "text");
    const isAgentTurn = payloadKind === "agentTurn" && textField(payload ?? {}, "message");
    if (
      !schedule ||
      !payload ||
      (!isAt && !isEvery && !isCron) ||
      (!isSystemEvent && !isAgentTurn)
    ) {
      continue;
    }
    update.run(
      textField(job, "name") ?? row.job_id,
      job.enabled === false ? 0 : 1,
      textField(job, "agentId"),
      payloadKind,
      numberField(job, "updatedAtMs") ?? (Number(row.updated_at) || 0),
      row.store_key,
      row.job_id,
    );
  }
}

function metadataStringField(record: Record<string, unknown>, key: string): string | null {
  return textField(record, key);
}

export function backfillDeliveryQueueEntriesFromEntryJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "delivery_queue_entries") ||
    !tableHasColumn(db, "delivery_queue_entries", "entry_json") ||
    !tableHasColumn(db, "delivery_queue_entries", "retry_count")
  ) {
    return;
  }
  compactLegacyDeliveryQueueFailures(db);
  const rows = db
    .prepare(
      `SELECT queue_name, id, entry_json
         FROM delivery_queue_entries
        WHERE status = 'pending'
          AND (retry_count = 0
            OR last_attempt_at IS NULL
            OR last_error IS NULL
            OR recovery_state IS NULL
            OR platform_send_started_at IS NULL
            OR entry_kind IS NULL
            OR session_key IS NULL
            OR channel IS NULL
            OR target IS NULL
            OR account_id IS NULL)`,
    )
    .all() as Array<{ queue_name: string; id: string; entry_json: string }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = COALESCE(?, entry_kind),
            session_key = COALESCE(?, session_key),
            channel = COALESCE(?, channel),
            target = COALESCE(?, target),
            account_id = COALESCE(?, account_id),
            retry_count = ?,
            last_attempt_at = COALESCE(?, last_attempt_at),
            last_error = COALESCE(?, last_error),
            recovery_state = COALESCE(?, recovery_state),
            platform_send_started_at = COALESCE(?, platform_send_started_at)
      WHERE queue_name = ?
        AND id = ?`,
  );
  for (const row of rows) {
    const entry = parseJsonRecord(row.entry_json);
    if (!entry) {
      continue;
    }
    // Queue metadata is denormalized for recovery queries but entry_json remains source of truth.
    const session = recordField(entry, "session");
    const route = recordField(entry, "route");
    const deliveryContext = recordField(entry, "deliveryContext");
    update.run(
      metadataStringField(entry, "kind"),
      metadataStringField(entry, "sessionKey") ??
        (session ? metadataStringField(session, "key") : null),
      metadataStringField(entry, "channel") ??
        (route ? metadataStringField(route, "channel") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "channel") : null),
      metadataStringField(entry, "to") ??
        (route ? metadataStringField(route, "to") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "to") : null),
      metadataStringField(entry, "accountId") ??
        (route ? metadataStringField(route, "accountId") : null) ??
        (deliveryContext ? metadataStringField(deliveryContext, "accountId") : null),
      asSafeIntegerInRange(entry.retryCount, { min: 0 }) ?? 0,
      asSafeIntegerInRange(entry.lastAttemptAt, { min: 0 }) ?? null,
      metadataStringField(entry, "lastError"),
      metadataStringField(entry, "recoveryState"),
      asSafeIntegerInRange(entry.platformSendStartedAt, { min: 0 }) ?? null,
      row.queue_name,
      row.id,
    );
  }
}

// The caller owns the state.schema.ensure transaction so every probe, DDL
// change, and backfill observes one authoritative schema across processes.
