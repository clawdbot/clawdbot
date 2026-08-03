import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Maps commitment records to the canonical shared SQLite table.
import type { Insertable, Selectable, Updateable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { CommitmentRecord } from "./types.js";

export type CommitmentsDatabase = Pick<OpenClawStateKyselyDatabase, "commitments">;
export type CommitmentRow = Selectable<CommitmentsDatabase["commitments"]>;
type CommitmentRowInsert = Insertable<CommitmentsDatabase["commitments"]>;
type CommitmentRowUpdate = Updateable<CommitmentsDatabase["commitments"]>;

const COMMITMENT_KINDS = new Set([
  "event_check_in",
  "deadline_check",
  "care_check_in",
  "open_loop",
]);
const COMMITMENT_SENSITIVITIES = new Set(["routine", "personal", "care"]);
const COMMITMENT_SOURCES = new Set(["inferred_user_context", "agent_promise"]);
const COMMITMENT_STATUSES = new Set(["pending", "sent", "dismissed", "snoozed", "expired"]);

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Validate a persisted record and remove retired raw-source fields. */
export function coerceCommitmentRecord(raw: unknown): CommitmentRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : undefined;
  if (!dueWindow) {
    return undefined;
  }

  const id = normalizeOptionalString(raw.id);
  const agentId = normalizeOptionalString(raw.agentId);
  const sessionKey = normalizeOptionalString(raw.sessionKey);
  const channel = normalizeOptionalString(raw.channel);
  const reason = normalizeOptionalString(raw.reason);
  const suggestedText = normalizeOptionalString(raw.suggestedText);
  const dedupeKey = normalizeOptionalString(raw.dedupeKey);
  const kind = normalizeOptionalString(raw.kind);
  const sensitivity = normalizeOptionalString(raw.sensitivity);
  const source = normalizeOptionalString(raw.source);
  const status = normalizeOptionalString(raw.status);
  const confidence = normalizeNonNegativeNumber(raw.confidence);
  const createdAtMs = normalizeNonNegativeNumber(raw.createdAtMs);
  const updatedAtMs = normalizeNonNegativeNumber(raw.updatedAtMs);
  const attempts = normalizeNonNegativeInteger(raw.attempts);
  const earliestMs = normalizeNonNegativeNumber(dueWindow.earliestMs);
  const latestMs = normalizeNonNegativeNumber(dueWindow.latestMs);
  const timezone = normalizeOptionalString(dueWindow.timezone);
  const accountId = normalizeOptionalString(raw.accountId);
  const to = normalizeOptionalString(raw.to);
  const threadId = normalizeOptionalString(raw.threadId);
  const senderId = normalizeOptionalString(raw.senderId);
  const sourceMessageId = normalizeOptionalString(raw.sourceMessageId);
  const sourceRunId = normalizeOptionalString(raw.sourceRunId);
  const lastAttemptAtMs = normalizeNonNegativeNumber(raw.lastAttemptAtMs);
  const sentAtMs = normalizeNonNegativeNumber(raw.sentAtMs);
  const dismissedAtMs = normalizeNonNegativeNumber(raw.dismissedAtMs);
  const snoozedUntilMs = normalizeNonNegativeNumber(raw.snoozedUntilMs);
  const expiredAtMs = normalizeNonNegativeNumber(raw.expiredAtMs);

  if (
    !id ||
    !agentId ||
    !sessionKey ||
    !channel ||
    !reason ||
    !suggestedText ||
    !dedupeKey ||
    !kind ||
    !sensitivity ||
    !source ||
    !status ||
    !COMMITMENT_KINDS.has(kind) ||
    !COMMITMENT_SENSITIVITIES.has(sensitivity) ||
    !COMMITMENT_SOURCES.has(source) ||
    !COMMITMENT_STATUSES.has(status) ||
    confidence === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    attempts === undefined ||
    earliestMs === undefined ||
    latestMs === undefined ||
    !timezone ||
    latestMs < earliestMs
  ) {
    return undefined;
  }

  return {
    id,
    agentId,
    sessionKey,
    channel,
    ...(accountId ? { accountId } : {}),
    ...(to ? { to } : {}),
    ...(threadId ? { threadId } : {}),
    ...(senderId ? { senderId } : {}),
    kind: kind as CommitmentRecord["kind"],
    sensitivity: sensitivity as CommitmentRecord["sensitivity"],
    source: source as CommitmentRecord["source"],
    status: status as CommitmentRecord["status"],
    reason,
    suggestedText,
    dedupeKey,
    confidence,
    dueWindow: { earliestMs, latestMs, timezone },
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
    createdAtMs,
    updatedAtMs,
    attempts,
    ...(lastAttemptAtMs !== undefined ? { lastAttemptAtMs } : {}),
    ...(sentAtMs !== undefined ? { sentAtMs } : {}),
    ...(dismissedAtMs !== undefined ? { dismissedAtMs } : {}),
    ...(snoozedUntilMs !== undefined ? { snoozedUntilMs } : {}),
    ...(expiredAtMs !== undefined ? { expiredAtMs } : {}),
  };
}

export function commitmentRecordFromRow(row: CommitmentRow): CommitmentRecord {
  const record = coerceCommitmentRecord({
    id: row.id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    channel: row.channel,
    ...(row.account_id !== null ? { accountId: row.account_id } : {}),
    ...(row.recipient_id !== null ? { to: row.recipient_id } : {}),
    ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    ...(row.sender_id !== null ? { senderId: row.sender_id } : {}),
    kind: row.kind,
    sensitivity: row.sensitivity,
    source: row.source,
    status: row.status,
    reason: row.reason,
    suggestedText: row.suggested_text,
    dedupeKey: row.dedupe_key,
    confidence: row.confidence,
    dueWindow: {
      earliestMs: row.due_earliest_ms,
      latestMs: row.due_latest_ms,
      timezone: row.due_timezone,
    },
    ...(row.source_message_id !== null ? { sourceMessageId: row.source_message_id } : {}),
    ...(row.source_run_id !== null ? { sourceRunId: row.source_run_id } : {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    attempts: row.attempts,
    ...(row.last_attempt_at_ms !== null ? { lastAttemptAtMs: row.last_attempt_at_ms } : {}),
    ...(row.sent_at_ms !== null ? { sentAtMs: row.sent_at_ms } : {}),
    ...(row.dismissed_at_ms !== null ? { dismissedAtMs: row.dismissed_at_ms } : {}),
    ...(row.snoozed_until_ms !== null ? { snoozedUntilMs: row.snoozed_until_ms } : {}),
    ...(row.expired_at_ms !== null ? { expiredAtMs: row.expired_at_ms } : {}),
  });
  if (!record) {
    throw new Error(`commitment row ${row.id} violates the canonical record contract`);
  }
  return record;
}

export function commitmentRecordToRow(record: CommitmentRecord): CommitmentRowInsert {
  return {
    id: record.id,
    agent_id: record.agentId,
    session_key: record.sessionKey,
    channel: record.channel,
    account_id: record.accountId ?? null,
    recipient_id: record.to ?? null,
    thread_id: record.threadId ?? null,
    sender_id: record.senderId ?? null,
    kind: record.kind,
    sensitivity: record.sensitivity,
    source: record.source,
    status: record.status,
    reason: record.reason,
    suggested_text: record.suggestedText,
    dedupe_key: record.dedupeKey,
    confidence: record.confidence,
    due_earliest_ms: record.dueWindow.earliestMs,
    due_latest_ms: record.dueWindow.latestMs,
    due_timezone: record.dueWindow.timezone,
    source_message_id: record.sourceMessageId ?? null,
    source_run_id: record.sourceRunId ?? null,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
    attempts: record.attempts,
    last_attempt_at_ms: record.lastAttemptAtMs ?? null,
    sent_at_ms: record.sentAtMs ?? null,
    dismissed_at_ms: record.dismissedAtMs ?? null,
    snoozed_until_ms: record.snoozedUntilMs ?? null,
    expired_at_ms: record.expiredAtMs ?? null,
    record_json: JSON.stringify(record),
  };
}

export function commitmentRecordToUpdate(record: CommitmentRecord): CommitmentRowUpdate {
  const { id: _id, ...update } = commitmentRecordToRow(record);
  return update;
}

export function commitmentRecordsEqual(left: CommitmentRecord, right: CommitmentRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function commitmentImmutableIdentity(record: CommitmentRecord): string {
  return JSON.stringify([
    record.id,
    record.agentId,
    record.sessionKey,
    record.channel,
    record.accountId ?? null,
    record.to ?? null,
    record.threadId ?? null,
    record.senderId ?? null,
    record.kind,
    record.sensitivity,
    record.source,
    record.dedupeKey,
    record.createdAtMs,
  ]);
}
