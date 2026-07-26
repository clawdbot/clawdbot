// Persists commitment records in the canonical shared SQLite database.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "../config/config.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS,
  DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
  resolveCommitmentsConfig,
} from "./config.js";
import {
  coerceCommitmentRecord,
  commitmentRecordFromRow,
  commitmentRecordToRow,
  commitmentRecordToUpdate,
  type CommitmentRow,
  type CommitmentsDatabase,
} from "./store-record.js";
import type {
  CommitmentCandidate,
  CommitmentExtractionItem,
  CommitmentRecord,
  CommitmentScope,
  CommitmentStatus,
} from "./types.js";

const ROLLING_DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["pending", "snoozed"] as const;

function databaseOptions(env: NodeJS.ProcessEnv = process.env): OpenClawStateDatabaseOptions {
  return { env };
}

export function resolveCommitmentDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveOpenClawStateSqlitePath(env);
}

function generateCommitmentId(nowMs: number): string {
  return `cm_${nowMs.toString(36)}_${randomBytes(5).toString("hex")}`;
}

function optionalScopeValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeScope(scope: CommitmentScope): CommitmentScope {
  return {
    agentId: scope.agentId.trim(),
    sessionKey: scope.sessionKey.trim(),
    channel: scope.channel.trim(),
    ...(optionalScopeValue(scope.accountId) ? { accountId: scope.accountId?.trim() } : {}),
    ...(optionalScopeValue(scope.to) ? { to: scope.to?.trim() } : {}),
    ...(optionalScopeValue(scope.threadId) ? { threadId: scope.threadId?.trim() } : {}),
    ...(optionalScopeValue(scope.senderId) ? { senderId: scope.senderId?.trim() } : {}),
  };
}

function candidateToRecord(params: {
  item: CommitmentExtractionItem;
  candidate: CommitmentCandidate;
  nowMs: number;
  earliestMs: number;
  latestMs: number;
  timezone: string;
}): CommitmentRecord | undefined {
  const scope = normalizeScope(params.item);
  return coerceCommitmentRecord({
    id: generateCommitmentId(params.nowMs),
    ...scope,
    kind: params.candidate.kind,
    sensitivity: params.candidate.sensitivity,
    source: params.candidate.source,
    status: "pending",
    reason: params.candidate.reason.trim(),
    suggestedText: params.candidate.suggestedText.trim(),
    dedupeKey: params.candidate.dedupeKey.trim(),
    confidence: params.candidate.confidence,
    dueWindow: {
      earliestMs: params.earliestMs,
      latestMs: params.latestMs,
      timezone: params.timezone,
    },
    ...(optionalScopeValue(params.item.sourceMessageId)
      ? { sourceMessageId: params.item.sourceMessageId?.trim() }
      : {}),
    ...(optionalScopeValue(params.item.sourceRunId)
      ? { sourceRunId: params.item.sourceRunId?.trim() }
      : {}),
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    attempts: 0,
  });
}

function expireAfterMs(): number {
  return DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS * 60 * 60 * 1000;
}

function updateCommitmentRow(db: DatabaseSync, record: CommitmentRecord): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<CommitmentsDatabase>(db)
      .updateTable("commitments")
      .set(commitmentRecordToUpdate(record))
      .where("id", "=", record.id),
  );
}

function expireStaleCommitmentsInTransaction(db: DatabaseSync, nowMs: number): number {
  const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    commitmentsDb
      .selectFrom("commitments")
      .selectAll()
      .where("status", "in", [...ACTIVE_STATUSES])
      .where("due_latest_ms", "<", nowMs - expireAfterMs()),
  ).rows;
  for (const row of rows) {
    updateCommitmentRow(db, {
      ...commitmentRecordFromRow(row),
      status: "expired",
      expiredAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }
  return rows.length;
}

function expireStaleCommitments(nowMs: number): number {
  return runOpenClawStateWriteTransaction(({ db }) =>
    expireStaleCommitmentsInTransaction(db, nowMs),
  );
}

function applyExactScopeWhere<Output>(
  query: import("kysely").SelectQueryBuilder<CommitmentsDatabase, "commitments", Output>,
  scope: CommitmentScope,
) {
  const normalized = normalizeScope(scope);
  let scoped = query
    .where("agent_id", "=", normalized.agentId)
    .where("session_key", "=", normalized.sessionKey)
    .where("channel", "=", normalized.channel);
  scoped = normalized.accountId
    ? scoped.where("account_id", "=", normalized.accountId)
    : scoped.where("account_id", "is", null);
  scoped = normalized.to
    ? scoped.where("recipient_id", "=", normalized.to)
    : scoped.where("recipient_id", "is", null);
  scoped = normalized.threadId
    ? scoped.where("thread_id", "=", normalized.threadId)
    : scoped.where("thread_id", "is", null);
  return normalized.senderId
    ? scoped.where("sender_id", "=", normalized.senderId)
    : scoped.where("sender_id", "is", null);
}

function activeAndUnsnoozed<Output>(
  query: import("kysely").SelectQueryBuilder<CommitmentsDatabase, "commitments", Output>,
  nowMs: number,
) {
  return query
    .where("status", "in", [...ACTIVE_STATUSES])
    .where((eb) =>
      eb.or([
        eb("status", "=", "pending"),
        eb("snoozed_until_ms", "is", null),
        eb("snoozed_until_ms", "<=", nowMs),
      ]),
    );
}

export async function listPendingCommitmentsForScope(params: {
  cfg?: OpenClawConfig;
  scope: CommitmentScope;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const nowMs = params.nowMs ?? Date.now();
  expireStaleCommitments(nowMs);
  const database = openOpenClawStateDatabase();
  const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
  const scoped = applyExactScopeWhere(
    commitmentsDb.selectFrom("commitments").selectAll(),
    params.scope,
  );
  return executeSqliteQuerySync(
    database.db,
    activeAndUnsnoozed(scoped, nowMs)
      .orderBy("due_earliest_ms", "asc")
      .orderBy("created_at_ms", "asc")
      .orderBy("id", "asc")
      .limit(params.limit ?? 20),
  ).rows.map(commitmentRecordFromRow);
}

export async function upsertInferredCommitments(params: {
  cfg?: OpenClawConfig;
  item: CommitmentExtractionItem;
  candidates: Array<{
    candidate: CommitmentCandidate;
    earliestMs: number;
    latestMs: number;
    timezone: string;
  }>;
  nowMs?: number;
}): Promise<CommitmentRecord[]> {
  if (params.candidates.length === 0) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const planned = params.candidates.flatMap((entry) => {
    const record = candidateToRecord({ item: params.item, ...entry, nowMs });
    return record ? [record] : [];
  });
  if (planned.length === 0) {
    return [];
  }
  const scope = normalizeScope(params.item);
  return runOpenClawStateWriteTransaction(({ db }) => {
    expireStaleCommitmentsInTransaction(db, nowMs);
    const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(db);
    const created: CommitmentRecord[] = [];
    for (const record of planned) {
      const scoped = applyExactScopeWhere(
        commitmentsDb.selectFrom("commitments").selectAll(),
        scope,
      );
      const existingRow = executeSqliteQueryTakeFirstSync(
        db,
        scoped
          .where("dedupe_key", "=", record.dedupeKey)
          .where("status", "in", [...ACTIVE_STATUSES])
          .orderBy("updated_at_ms", "desc")
          .orderBy("id", "asc"),
      );
      if (existingRow) {
        const existing = commitmentRecordFromRow(existingRow);
        updateCommitmentRow(db, {
          ...existing,
          reason: record.reason,
          suggestedText: record.suggestedText,
          confidence: Math.max(existing.confidence, record.confidence),
          dueWindow: {
            earliestMs: Math.min(existing.dueWindow.earliestMs, record.dueWindow.earliestMs),
            latestMs: Math.max(existing.dueWindow.latestMs, record.dueWindow.latestMs),
            timezone: record.dueWindow.timezone,
          },
          updatedAtMs: nowMs,
        });
        continue;
      }
      executeSqliteQuerySync(
        db,
        commitmentsDb.insertInto("commitments").values(commitmentRecordToRow(record)),
      );
      created.push(record);
    }
    return created;
  }, databaseOptions());
}

export async function listDueCommitmentsForSession(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  if (!resolved.enabled) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  expireStaleCommitments(nowMs);
  const database = openOpenClawStateDatabase();
  const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
  const sentCountRow = executeSqliteQueryTakeFirstSync(
    database.db,
    commitmentsDb
      .selectFrom("commitments")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("agent_id", "=", params.agentId)
      .where("session_key", "=", params.sessionKey)
      .where("status", "=", "sent")
      .where("sent_at_ms", ">=", nowMs - ROLLING_DAY_MS),
  );
  const remainingToday = resolved.maxPerDay - Number(sentCountRow?.count ?? 0);
  if (remainingToday <= 0) {
    return [];
  }
  const limit = Math.min(
    params.limit ?? DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
    remainingToday,
    DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
  );
  const due = activeAndUnsnoozed(
    commitmentsDb
      .selectFrom("commitments")
      .selectAll()
      .where("agent_id", "=", params.agentId)
      .where("session_key", "=", params.sessionKey),
    nowMs,
  )
    .where("due_earliest_ms", "<=", nowMs)
    .where("due_latest_ms", ">=", nowMs - expireAfterMs())
    .orderBy("due_earliest_ms", "asc")
    .orderBy("created_at_ms", "asc")
    .orderBy("id", "asc")
    .limit(limit);
  return executeSqliteQuerySync(database.db, due).rows.map(commitmentRecordFromRow);
}

export async function listDueCommitmentSessionKeys(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  nowMs?: number;
  limit?: number;
}): Promise<string[]> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  if (!resolved.enabled) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  expireStaleCommitments(nowMs);
  const database = openOpenClawStateDatabase();
  const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
  const dueSessionRows = executeSqliteQuerySync(
    database.db,
    activeAndUnsnoozed(
      commitmentsDb
        .selectFrom("commitments")
        .select("session_key")
        .distinct()
        .where("agent_id", "=", params.agentId),
      nowMs,
    )
      .where("due_earliest_ms", "<=", nowMs)
      .where("due_latest_ms", ">=", nowMs - expireAfterMs())
      .orderBy("session_key", "asc"),
  ).rows;
  if (dueSessionRows.length === 0) {
    return [];
  }
  const sentCountRows = executeSqliteQuerySync(
    database.db,
    commitmentsDb
      .selectFrom("commitments")
      .select(["session_key", (eb) => eb.fn.countAll<number | bigint>().as("count")])
      .where("agent_id", "=", params.agentId)
      .where("status", "=", "sent")
      .where("sent_at_ms", ">=", nowMs - ROLLING_DAY_MS)
      .groupBy("session_key"),
  ).rows;
  const sentCounts = new Map(sentCountRows.map((row) => [row.session_key, Number(row.count)]));
  const eligible = dueSessionRows
    .map((row) => row.session_key)
    .filter((sessionKey) => (sentCounts.get(sessionKey) ?? 0) < resolved.maxPerDay);
  return params.limit && params.limit > 0 ? eligible.slice(0, params.limit) : eligible;
}

export async function markCommitmentsAttempted(params: {
  cfg?: OpenClawConfig;
  ids: string[];
  nowMs?: number;
}): Promise<void> {
  const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      commitmentsDb.selectFrom("commitments").selectAll().where("id", "in", ids),
    ).rows;
    for (const row of rows) {
      const record = commitmentRecordFromRow(row);
      updateCommitmentRow(db, {
        ...record,
        attempts: record.attempts + 1,
        lastAttemptAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
  });
}

export async function markCommitmentsStatus(params: {
  cfg?: OpenClawConfig;
  ids: string[];
  status: Extract<CommitmentStatus, "sent" | "dismissed" | "expired">;
  nowMs?: number;
}): Promise<void> {
  const ids = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      commitmentsDb
        .selectFrom("commitments")
        .selectAll()
        .where("id", "in", ids)
        .where("status", "in", [...ACTIVE_STATUSES]),
    ).rows;
    for (const row of rows) {
      const record = commitmentRecordFromRow(row);
      updateCommitmentRow(db, {
        ...record,
        status: params.status,
        updatedAtMs: nowMs,
        ...(params.status === "sent" ? { sentAtMs: nowMs } : {}),
        ...(params.status === "dismissed" ? { dismissedAtMs: nowMs } : {}),
        ...(params.status === "expired" ? { expiredAtMs: nowMs } : {}),
      });
    }
  });
}

export async function listCommitments(params?: {
  cfg?: OpenClawConfig;
  status?: CommitmentStatus;
  agentId?: string;
  nowMs?: number;
}): Promise<CommitmentRecord[]> {
  expireStaleCommitments(params?.nowMs ?? Date.now());
  const database = openOpenClawStateDatabase();
  const commitmentsDb = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
  let query = commitmentsDb.selectFrom("commitments").selectAll();
  if (params?.status) {
    query = query.where("status", "=", params.status);
  }
  if (params?.agentId) {
    query = query.where("agent_id", "=", params.agentId);
  }
  return executeSqliteQuerySync(
    database.db,
    query.orderBy("due_earliest_ms", "asc").orderBy("created_at_ms", "asc").orderBy("id", "asc"),
  ).rows.map((row: CommitmentRow) => commitmentRecordFromRow(row));
}
