import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import { expandHomePrefix } from "../infra/home-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { normalizeCronJobIdentityFields } from "./normalize-job-identity.js";
import { normalizeCronJobInput } from "./normalize.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import { tryCronScheduleIdentity } from "./schedule-identity.js";
import type {
  CronDelivery,
  CronFailureAlert,
  CronJob,
  CronJobState,
  CronPayload,
  CronSchedule,
  CronStoreFile,
} from "./types.js";

export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

export type CronQuarantineFile = {
  version: 1;
  jobs: Array<QuarantinedCronConfigJob & { quarantinedAtMs: number }>;
};

export type LoadedCronStore = {
  store: CronStoreFile;
  configJobs: Array<Record<string, unknown>>;
  configJobIndexes: number[];
  configJobRuntimeEntries: CronConfigJobRuntimeEntry[];
  invalidConfigRows: QuarantinedCronConfigJob[];
};

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultCronStorePath(): string {
  return path.join(resolveDefaultCronDir(), "jobs.json");
}

export function resolveCronQuarantinePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-quarantine.json");
  }
  return `${storePath}-quarantine.json`;
}

type CronStateFileEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

export type CronConfigJobRuntimeEntry = CronStateFileEntry;

type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronStoreDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;
type CronJobRow = Selectable<CronJobsTable>;
type CronJobInsert = Insertable<CronJobsTable>;

function cronStoreKey(storePath: string): string {
  return path.resolve(storePath);
}

function getCronStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<CronStoreDatabase>(db);
}

function parseJsonObject<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonValue<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function booleanToInteger(value: boolean | undefined): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function integerToBoolean(value: number | bigint | null): boolean | undefined {
  const normalized = normalizeNumber(value);
  return normalized == null ? undefined : normalized !== 0;
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseJsonArray(raw: string | null): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = parseJsonObject<unknown>(raw, undefined);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : undefined;
}

function optionalStringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalBooleanFromRecord(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumberFromRecord(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArrayFromRecord(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function parseExternalContentSource(
  raw: string | null,
  fallback: unknown,
): "gmail" | "webhook" | undefined {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : fallback;
  return parsed === "gmail" || parsed === "webhook" ? parsed : undefined;
}

function bindScheduleColumns(
  schedule: CronSchedule,
): Pick<
  CronJobInsert,
  "anchor_ms" | "at" | "every_ms" | "schedule_expr" | "schedule_kind" | "schedule_tz" | "stagger_ms"
> {
  if (schedule.kind === "at") {
    return {
      schedule_kind: "at",
      at: schedule.at,
      every_ms: null,
      anchor_ms: null,
      schedule_expr: null,
      schedule_tz: null,
      stagger_ms: null,
    };
  }
  if (schedule.kind === "every") {
    return {
      schedule_kind: "every",
      at: null,
      every_ms: schedule.everyMs,
      anchor_ms: schedule.anchorMs ?? null,
      schedule_expr: null,
      schedule_tz: null,
      stagger_ms: null,
    };
  }
  return {
    schedule_kind: "cron",
    at: null,
    every_ms: null,
    anchor_ms: null,
    schedule_expr: schedule.expr,
    schedule_tz: schedule.tz ?? null,
    stagger_ms: schedule.staggerMs ?? null,
  };
}

function bindPayloadColumns(
  payload: CronPayload,
): Pick<
  CronJobInsert,
  | "payload_allow_unsafe_external_content"
  | "payload_external_content_source_json"
  | "payload_fallbacks_json"
  | "payload_kind"
  | "payload_light_context"
  | "payload_message"
  | "payload_model"
  | "payload_thinking"
  | "payload_timeout_seconds"
  | "payload_tools_allow_json"
> {
  if (payload.kind === "systemEvent") {
    return {
      payload_kind: "systemEvent",
      payload_message: payload.text,
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  return {
    payload_kind: "agentTurn",
    payload_message: payload.message,
    payload_model: payload.model ?? null,
    payload_fallbacks_json: serializeJson(payload.fallbacks),
    payload_thinking: payload.thinking ?? null,
    payload_timeout_seconds: payload.timeoutSeconds ?? null,
    payload_allow_unsafe_external_content: booleanToInteger(payload.allowUnsafeExternalContent),
    payload_external_content_source_json: serializeJson(payload.externalContentSource),
    payload_light_context: booleanToInteger(payload.lightContext),
    payload_tools_allow_json: serializeJson(payload.toolsAllow),
  };
}

function bindDeliveryColumns(
  delivery: CronDelivery | undefined,
): Pick<
  CronJobInsert,
  | "delivery_account_id"
  | "delivery_best_effort"
  | "delivery_channel"
  | "delivery_mode"
  | "delivery_thread_id"
  | "delivery_to"
  | "failure_delivery_account_id"
  | "failure_delivery_channel"
  | "failure_delivery_mode"
  | "failure_delivery_to"
> {
  return {
    delivery_mode: delivery?.mode ?? null,
    delivery_channel: delivery?.channel ?? null,
    delivery_to: delivery?.to ?? null,
    delivery_thread_id:
      delivery?.threadId === undefined || delivery.threadId === null
        ? null
        : String(delivery.threadId),
    delivery_account_id: delivery?.accountId ?? null,
    delivery_best_effort: booleanToInteger(delivery?.bestEffort),
    failure_delivery_mode: delivery?.failureDestination?.mode ?? null,
    failure_delivery_channel: delivery?.failureDestination?.channel ?? null,
    failure_delivery_to: delivery?.failureDestination?.to ?? null,
    failure_delivery_account_id: delivery?.failureDestination?.accountId ?? null,
  };
}

function bindFailureAlertColumns(
  failureAlert: CronFailureAlert | false | undefined,
): Pick<
  CronJobInsert,
  | "failure_alert_account_id"
  | "failure_alert_after"
  | "failure_alert_channel"
  | "failure_alert_cooldown_ms"
  | "failure_alert_disabled"
  | "failure_alert_include_skipped"
  | "failure_alert_mode"
  | "failure_alert_to"
> {
  if (failureAlert === false) {
    return {
      failure_alert_disabled: 1,
      failure_alert_after: null,
      failure_alert_channel: null,
      failure_alert_to: null,
      failure_alert_cooldown_ms: null,
      failure_alert_include_skipped: null,
      failure_alert_mode: null,
      failure_alert_account_id: null,
    };
  }
  return {
    failure_alert_disabled: failureAlert ? 0 : null,
    failure_alert_after: failureAlert?.after ?? null,
    failure_alert_channel: failureAlert?.channel ?? null,
    failure_alert_to: failureAlert?.to ?? null,
    failure_alert_cooldown_ms: failureAlert?.cooldownMs ?? null,
    failure_alert_include_skipped: booleanToInteger(failureAlert?.includeSkipped),
    failure_alert_mode: failureAlert?.mode ?? null,
    failure_alert_account_id: failureAlert?.accountId ?? null,
  };
}

function bindStateColumns(
  state: CronJobState,
): Pick<
  CronJobInsert,
  | "consecutive_errors"
  | "consecutive_skipped"
  | "last_delivered"
  | "last_delivery_error"
  | "last_delivery_status"
  | "last_duration_ms"
  | "last_error"
  | "last_failure_alert_at_ms"
  | "last_run_at_ms"
  | "last_run_status"
  | "next_run_at_ms"
  | "running_at_ms"
  | "schedule_error_count"
> {
  return {
    next_run_at_ms: state.nextRunAtMs ?? null,
    running_at_ms: state.runningAtMs ?? null,
    last_run_at_ms: state.lastRunAtMs ?? null,
    last_run_status: state.lastRunStatus ?? state.lastStatus ?? null,
    last_error: state.lastError ?? null,
    last_duration_ms: state.lastDurationMs ?? null,
    consecutive_errors: state.consecutiveErrors ?? null,
    consecutive_skipped: state.consecutiveSkipped ?? null,
    schedule_error_count: state.scheduleErrorCount ?? null,
    last_delivery_status: state.lastDeliveryStatus ?? null,
    last_delivery_error: state.lastDeliveryError ?? null,
    last_delivered: booleanToInteger(state.lastDelivered),
    last_failure_alert_at_ms: state.lastFailureAlertAtMs ?? null,
  };
}

function bindCronJobRow(storeKey: string, job: CronJob, sortOrder: number): CronJobInsert {
  return {
    store_key: storeKey,
    job_id: job.id,
    name: job.name,
    description: job.description ?? null,
    enabled: job.enabled ? 1 : 0,
    delete_after_run: booleanToInteger(job.deleteAfterRun),
    created_at_ms: job.createdAtMs,
    updated_at: job.updatedAtMs,
    agent_id: job.agentId ?? null,
    session_key: job.sessionKey ?? null,
    session_target: job.sessionTarget,
    wake_mode: job.wakeMode,
    ...bindScheduleColumns(job.schedule),
    ...bindPayloadColumns(job.payload),
    ...bindDeliveryColumns(job.delivery),
    ...bindFailureAlertColumns(job.failureAlert),
    ...bindStateColumns(job.state ?? {}),
    job_json: JSON.stringify(stripJobRuntimeFields(job)),
    state_json: JSON.stringify(job.state ?? {}),
    runtime_updated_at_ms: job.updatedAtMs,
    schedule_identity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>) ?? null,
    sort_order: sortOrder,
  };
}

function normalizeCronJobForSqlite(job: CronStoreFile["jobs"][number]): CronJob | null {
  const raw = structuredClone(job) as unknown as Record<string, unknown>;
  const hadDeleteAfterRun = Object.hasOwn(raw, "deleteAfterRun");
  normalizeCronJobIdentityFields(raw);
  const normalized = normalizeCronJobInput(raw, { applyDefaults: true });
  if (!normalized || getInvalidPersistedCronJobReason(normalized)) {
    return null;
  }
  if (!hadDeleteAfterRun) {
    delete normalized.deleteAfterRun;
  }
  const createdAtMs =
    typeof normalized.createdAtMs === "number" && Number.isFinite(normalized.createdAtMs)
      ? normalized.createdAtMs
      : Date.now();
  const updatedAtMs =
    typeof normalized.updatedAtMs === "number" && Number.isFinite(normalized.updatedAtMs)
      ? normalized.updatedAtMs
      : createdAtMs;
  return {
    ...normalized,
    createdAtMs,
    updatedAtMs,
    state: isRecord(normalized.state) ? (normalized.state as CronJobState) : {},
  } as CronJob;
}

function countUnpersistableCronJobs(store: CronStoreFile): number {
  return store.jobs.reduce((count, job) => count + (normalizeCronJobForSqlite(job) ? 0 : 1), 0);
}

function assertCronStoreCanPersist(store: CronStoreFile): void {
  const invalidJobs = countUnpersistableCronJobs(store);
  if (invalidJobs > 0) {
    throw new Error(`Cannot persist cron store with ${invalidJobs} invalid job(s)`);
  }
}

function scheduleFromRow(row: CronJobRow): CronSchedule | null {
  if (row.schedule_kind === "at" && row.at) {
    return { kind: "at", at: row.at };
  }
  if (row.schedule_kind === "every" && row.every_ms != null) {
    return {
      kind: "every",
      everyMs: normalizeNumber(row.every_ms) ?? 0,
      ...(row.anchor_ms != null ? { anchorMs: normalizeNumber(row.anchor_ms) } : {}),
    };
  }
  if (row.schedule_kind === "cron" && row.schedule_expr) {
    return {
      kind: "cron",
      expr: row.schedule_expr,
      ...(row.schedule_tz ? { tz: row.schedule_tz } : {}),
      ...(row.stagger_ms != null ? { staggerMs: normalizeNumber(row.stagger_ms) } : {}),
    };
  }
  return null;
}

function payloadFromRow(row: CronJobRow, fallback: unknown): CronPayload | null {
  const fallbackRecord = isRecord(fallback) ? fallback : {};
  if (row.payload_kind === "systemEvent") {
    const text = row.payload_message ?? optionalStringFromRecord(fallbackRecord, "text");
    return text == null ? null : { kind: "systemEvent", text };
  }
  if (row.payload_kind === "agentTurn") {
    const message = row.payload_message ?? optionalStringFromRecord(fallbackRecord, "message");
    if (message == null) {
      return null;
    }
    const model = row.payload_model ?? optionalStringFromRecord(fallbackRecord, "model");
    const fallbacks = row.payload_fallbacks_json
      ? parseJsonArray(row.payload_fallbacks_json)
      : optionalStringArrayFromRecord(fallbackRecord, "fallbacks");
    const thinking = row.payload_thinking ?? optionalStringFromRecord(fallbackRecord, "thinking");
    const timeoutSeconds =
      row.payload_timeout_seconds != null
        ? normalizeNumber(row.payload_timeout_seconds)
        : optionalNumberFromRecord(fallbackRecord, "timeoutSeconds");
    const allowUnsafeExternalContent =
      row.payload_allow_unsafe_external_content != null
        ? integerToBoolean(row.payload_allow_unsafe_external_content)
        : optionalBooleanFromRecord(fallbackRecord, "allowUnsafeExternalContent");
    const externalContentSource = parseExternalContentSource(
      row.payload_external_content_source_json,
      fallbackRecord.externalContentSource,
    );
    const lightContext =
      row.payload_light_context != null
        ? integerToBoolean(row.payload_light_context)
        : optionalBooleanFromRecord(fallbackRecord, "lightContext");
    const toolsAllow = row.payload_tools_allow_json
      ? parseJsonArray(row.payload_tools_allow_json)
      : optionalStringArrayFromRecord(fallbackRecord, "toolsAllow");
    return {
      kind: "agentTurn",
      message,
      ...(model ? { model } : {}),
      ...(fallbacks ? { fallbacks } : {}),
      ...(thinking ? { thinking } : {}),
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...(allowUnsafeExternalContent != null ? { allowUnsafeExternalContent } : {}),
      ...(externalContentSource ? { externalContentSource } : {}),
      ...(lightContext != null ? { lightContext } : {}),
      ...(toolsAllow ? { toolsAllow } : {}),
    };
  }
  return null;
}

function deliveryFromRow(row: CronJobRow): CronDelivery | undefined {
  if (!row.delivery_mode) {
    return undefined;
  }
  return {
    mode: row.delivery_mode as CronDelivery["mode"],
    ...(row.delivery_channel ? { channel: row.delivery_channel as CronDelivery["channel"] } : {}),
    ...(row.delivery_to ? { to: row.delivery_to } : {}),
    ...(row.delivery_thread_id ? { threadId: row.delivery_thread_id } : {}),
    ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
    ...(row.delivery_best_effort != null
      ? { bestEffort: integerToBoolean(row.delivery_best_effort) }
      : {}),
    ...(row.failure_delivery_channel ||
    row.failure_delivery_to ||
    row.failure_delivery_mode ||
    row.failure_delivery_account_id
      ? {
          failureDestination: {
            ...(row.failure_delivery_channel
              ? { channel: row.failure_delivery_channel as CronDelivery["channel"] }
              : {}),
            ...(row.failure_delivery_to ? { to: row.failure_delivery_to } : {}),
            ...(row.failure_delivery_mode
              ? { mode: row.failure_delivery_mode as "announce" | "webhook" }
              : {}),
            ...(row.failure_delivery_account_id
              ? { accountId: row.failure_delivery_account_id }
              : {}),
          },
        }
      : {}),
  };
}

function failureAlertFromRow(row: CronJobRow): CronFailureAlert | false | undefined {
  if (row.failure_alert_disabled === 1) {
    return false;
  }
  if (
    row.failure_alert_after == null &&
    !row.failure_alert_channel &&
    !row.failure_alert_to &&
    row.failure_alert_cooldown_ms == null &&
    row.failure_alert_include_skipped == null &&
    !row.failure_alert_mode &&
    !row.failure_alert_account_id
  ) {
    return undefined;
  }
  return {
    ...(row.failure_alert_after != null ? { after: normalizeNumber(row.failure_alert_after) } : {}),
    ...(row.failure_alert_channel
      ? { channel: row.failure_alert_channel as CronFailureAlert["channel"] }
      : {}),
    ...(row.failure_alert_to ? { to: row.failure_alert_to } : {}),
    ...(row.failure_alert_cooldown_ms != null
      ? { cooldownMs: normalizeNumber(row.failure_alert_cooldown_ms) }
      : {}),
    ...(row.failure_alert_include_skipped != null
      ? { includeSkipped: integerToBoolean(row.failure_alert_include_skipped) }
      : {}),
    ...(row.failure_alert_mode ? { mode: row.failure_alert_mode as "announce" | "webhook" } : {}),
    ...(row.failure_alert_account_id ? { accountId: row.failure_alert_account_id } : {}),
  };
}

function stateFromRow(row: CronJobRow): CronJobState {
  return {
    ...parseJsonObject<CronJobState>(row.state_json, {}),
    ...(row.next_run_at_ms != null ? { nextRunAtMs: normalizeNumber(row.next_run_at_ms) } : {}),
    ...(row.running_at_ms != null ? { runningAtMs: normalizeNumber(row.running_at_ms) } : {}),
    ...(row.last_run_at_ms != null ? { lastRunAtMs: normalizeNumber(row.last_run_at_ms) } : {}),
    ...(row.last_run_status
      ? { lastRunStatus: row.last_run_status as CronJobState["lastRunStatus"] }
      : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_duration_ms != null
      ? { lastDurationMs: normalizeNumber(row.last_duration_ms) }
      : {}),
    ...(row.consecutive_errors != null
      ? { consecutiveErrors: normalizeNumber(row.consecutive_errors) }
      : {}),
    ...(row.consecutive_skipped != null
      ? { consecutiveSkipped: normalizeNumber(row.consecutive_skipped) }
      : {}),
    ...(row.schedule_error_count != null
      ? { scheduleErrorCount: normalizeNumber(row.schedule_error_count) }
      : {}),
    ...(row.last_delivery_status
      ? { lastDeliveryStatus: row.last_delivery_status as CronJobState["lastDeliveryStatus"] }
      : {}),
    ...(row.last_delivery_error ? { lastDeliveryError: row.last_delivery_error } : {}),
    ...(row.last_delivered != null ? { lastDelivered: integerToBoolean(row.last_delivered) } : {}),
    ...(row.last_failure_alert_at_ms != null
      ? { lastFailureAlertAtMs: normalizeNumber(row.last_failure_alert_at_ms) }
      : {}),
  };
}

function rowToCronJob(row: CronJobRow): CronJob | null {
  const base = parseJsonObject<Partial<CronJob>>(row.job_json, {});
  const schedule = scheduleFromRow(row) ?? base.schedule;
  const payload = payloadFromRow(row, base.payload) ?? base.payload;
  if (!schedule || !payload) {
    return null;
  }
  return {
    ...base,
    id: row.job_id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.enabled !== 0,
    ...(row.delete_after_run != null
      ? { deleteAfterRun: integerToBoolean(row.delete_after_run) }
      : {}),
    createdAtMs: normalizeNumber(row.created_at_ms) ?? base.createdAtMs ?? Date.now(),
    updatedAtMs:
      normalizeNumber(row.runtime_updated_at_ms) ??
      normalizeNumber(row.updated_at) ??
      base.updatedAtMs ??
      Date.now(),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    schedule,
    sessionTarget: row.session_target as CronJob["sessionTarget"],
    wakeMode: row.wake_mode as CronJob["wakeMode"],
    payload,
    ...(deliveryFromRow(row) ? { delivery: deliveryFromRow(row) } : {}),
    ...(failureAlertFromRow(row) !== undefined ? { failureAlert: failureAlertFromRow(row) } : {}),
    state: stateFromRow(row),
  };
}

function loadCronRows(db: DatabaseSync, storeKey: string): CronJobRow[] {
  return executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .selectAll()
      .where("store_key", "=", storeKey)
      .orderBy("sort_order", "asc")
      .orderBy("updated_at", "asc")
      .orderBy("job_id", "asc"),
  ).rows;
}

function replaceCronRows(db: DatabaseSync, storeKey: string, store: CronStoreFile): void {
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db).deleteFrom("cron_jobs").where("store_key", "=", storeKey),
  );
  for (const [index, job] of store.jobs.entries()) {
    const normalized = normalizeCronJobForSqlite(job);
    if (!normalized) {
      continue;
    }
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .insertInto("cron_jobs")
        .values(bindCronJobRow(storeKey, normalized, index)),
    );
  }
}

function updateCronRuntimeRows(db: DatabaseSync, storeKey: string, store: CronStoreFile): void {
  for (const job of store.jobs) {
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .updateTable("cron_jobs")
        .set({
          ...bindStateColumns(job.state ?? {}),
          state_json: JSON.stringify(job.state ?? {}),
          runtime_updated_at_ms: job.updatedAtMs,
          schedule_identity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>),
        })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", job.id),
    );
  }
}

function loadedCronStoreFromRows(rows: CronJobRow[]): LoadedCronStore {
  const jobs = rows.map(rowToCronJob).filter((job): job is CronJob => job !== null);
  const configJobs = rows.map((row) =>
    parseJsonObject<Record<string, unknown>>(
      row.job_json,
      stripJobRuntimeFields(rowToCronJob(row) ?? ({} as CronJob)),
    ),
  );
  const configJobRuntimeEntries = rows.map((row) => ({
    updatedAtMs: normalizeNumber(row.runtime_updated_at_ms) ?? normalizeNumber(row.updated_at),
    scheduleIdentity: row.schedule_identity ?? undefined,
    state: stateFromRow(row) as Record<string, unknown>,
  }));
  return {
    store: { version: 1, jobs },
    configJobs,
    configJobIndexes: rows.map((_row, index) => index),
    configJobRuntimeEntries,
    invalidConfigRows: [],
  };
}

function stripJobRuntimeFields(job: CronStoreFile["jobs"][number]): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  return { ...rest, state: {} };
}

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath();
}

export async function loadCronStoreWithConfigJobs(storePath: string): Promise<LoadedCronStore> {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase().db;
  const rows = loadCronRows(database, storeKey);
  if (rows.length > 0) {
    return loadedCronStoreFromRows(rows);
  }
  return {
    store: { version: 1, jobs: [] },
    configJobs: [],
    configJobIndexes: [],
    configJobRuntimeEntries: [],
    invalidConfigRows: [],
  };
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return (await loadCronStoreWithConfigJobs(storePath)).store;
}

export function loadCronStoreSync(storePath: string): CronStoreFile {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  const database = openOpenClawStateDatabase().db;
  const rows = loadCronRows(database, storeKey);
  if (rows.length > 0) {
    return loadedCronStoreFromRows(rows).store;
  }
  return { version: 1, jobs: [] };
}

type SaveCronStoreOptions = {
  stateOnly?: boolean;
};

async function atomicWrite(filePath: string, content: string, dirMode = 0o700): Promise<void> {
  await replaceFileAtomic({
    filePath,
    content,
    dirMode,
    mode: 0o600,
    tempPrefix: ".openclaw-cron",
    renameMaxRetries: 3,
    copyFallbackOnPermissionError: true,
  });
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  const resolvedStorePath = path.resolve(storePath);
  const storeKey = cronStoreKey(resolvedStorePath);
  if (opts?.stateOnly) {
    runOpenClawStateWriteTransaction(({ db }) => {
      updateCronRuntimeRows(db, storeKey, store);
    });
    return;
  }
  assertCronStoreCanPersist(store);
  runOpenClawStateWriteTransaction(({ db }) => {
    replaceCronRows(db, storeKey, store);
  });
}

export async function loadCronQuarantineFile(path: string): Promise<CronQuarantineFile> {
  try {
    const raw = await fs.promises.readFile(path, "utf-8");
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      throw new Error(`Unsupported cron quarantine file shape at ${path}`);
    }
    const jobs = parsed.jobs.map((entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.reason !== "string" ||
        (!isRecord(entry.job) && !("raw" in entry))
      ) {
        throw new Error(`Unsupported cron quarantine entry at ${path} index ${index}`);
      }
      const sourceIndex = typeof entry.sourceIndex === "number" ? entry.sourceIndex : -1;
      const quarantinedAtMs =
        typeof entry.quarantinedAtMs === "number" && Number.isFinite(entry.quarantinedAtMs)
          ? entry.quarantinedAtMs
          : Date.now();
      const quarantined: CronQuarantineFile["jobs"][number] = {
        quarantinedAtMs,
        sourceIndex,
        reason: entry.reason,
      };
      if (isRecord(entry.job)) {
        quarantined.job = entry.job;
      }
      if ("raw" in entry) {
        quarantined.raw = entry.raw;
      }
      if (isRecord(entry.state)) {
        quarantined.state = entry.state;
      }
      if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
        quarantined.updatedAtMs = entry.updatedAtMs;
      }
      if (typeof entry.scheduleIdentity === "string") {
        quarantined.scheduleIdentity = entry.scheduleIdentity;
      }
      return quarantined;
    });
    return { version: 1, jobs };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

function quarantineEntryKey(entry: QuarantinedCronConfigJob): string {
  const rawId = entry.job
    ? (normalizeOptionalString(entry.job.id) ?? normalizeOptionalString(entry.job.jobId))
    : null;
  return JSON.stringify({
    id: rawId ?? null,
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
    job: entry.job ?? null,
    raw: entry.raw ?? null,
    state: entry.state ?? null,
    updatedAtMs: entry.updatedAtMs ?? null,
    scheduleIdentity: entry.scheduleIdentity ?? null,
  });
}

export async function saveCronQuarantineFile(params: {
  storePath: string;
  entries: QuarantinedCronConfigJob[];
  nowMs: number;
}) {
  if (params.entries.length === 0) {
    return null;
  }
  const quarantinePath = resolveCronQuarantinePath(params.storePath);
  const existing = await loadCronQuarantineFile(quarantinePath);
  const seen = new Set(existing.jobs.map(quarantineEntryKey));
  const nextJobs = existing.jobs.slice();
  let appended = false;
  for (const entry of params.entries.toSorted((a, b) => a.sourceIndex - b.sourceIndex)) {
    const key = quarantineEntryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    appended = true;
    nextJobs.push({
      quarantinedAtMs: params.nowMs,
      sourceIndex: entry.sourceIndex,
      reason: entry.reason,
      ...(entry.job ? { job: structuredClone(entry.job) } : {}),
      ...("raw" in entry ? { raw: structuredClone(entry.raw) } : {}),
      ...(entry.state ? { state: structuredClone(entry.state) } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
      ...(entry.scheduleIdentity !== undefined ? { scheduleIdentity: entry.scheduleIdentity } : {}),
    });
  }
  if (!appended) {
    return quarantinePath;
  }
  const payload = JSON.stringify({ version: 1, jobs: nextJobs }, null, 2);
  await atomicWrite(quarantinePath, payload);
  return quarantinePath;
}
