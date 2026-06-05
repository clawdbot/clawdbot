/** Converts cron jobs between public store shape and normalized SQLite rows. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import type { CronJob, CronJobState, CronSchedule, CronStoreFile } from "../types.js";
import { bindDeliveryColumns, deliveryFromRow } from "./delivery-codec.js";
import { bindFailureAlertColumns, failureAlertFromRow } from "./failure-alert-codec.js";
import { bindPayloadColumns, payloadFromRow } from "./payload-codec.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  parseJsonObject,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";
import { getCronStoreKysely } from "./schema.js";
import { bindStateColumns, stateFromRow } from "./state-codec.js";
import type { LoadedCronStore } from "./types.js";

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

function stripJobRuntimeFields(job: CronStoreFile["jobs"][number]): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  // job_json stores config shape only; runtime state lives in split columns and
  // state_json so state-only writes never rewrite public job config.
  return { ...rest, state: {} };
}

function mergeFailureDestinationProjection(
  configJob: Record<string, unknown>,
  projectedJob: CronJob | null,
): Record<string, unknown> {
  const failureDestination = projectedJob?.delivery?.failureDestination;
  if (!failureDestination) {
    return configJob;
  }
  // Empty SQLite sentinels preserve explicit undefined fields for failure
  // destination overrides; project them back into the config sidecar shape.
  const delivery: Record<string, unknown> =
    isRecord(configJob.delivery) && !Array.isArray(configJob.delivery)
      ? { ...configJob.delivery }
      : projectedJob?.delivery
        ? {
            mode: projectedJob.delivery.mode,
            ...(projectedJob.delivery.channel ? { channel: projectedJob.delivery.channel } : {}),
            ...(projectedJob.delivery.to ? { to: projectedJob.delivery.to } : {}),
            ...(projectedJob.delivery.threadId !== undefined
              ? { threadId: projectedJob.delivery.threadId }
              : {}),
            ...(projectedJob.delivery.accountId
              ? { accountId: projectedJob.delivery.accountId }
              : {}),
            ...(projectedJob.delivery.bestEffort !== undefined
              ? { bestEffort: projectedJob.delivery.bestEffort }
              : {}),
            ...(projectedJob.delivery.completionDestination
              ? { completionDestination: projectedJob.delivery.completionDestination }
              : {}),
          }
        : {};
  const nextFailureDestination = isRecord(delivery.failureDestination)
    ? { ...delivery.failureDestination }
    : {};
  if (Object.hasOwn(failureDestination, "channel")) {
    nextFailureDestination.channel = failureDestination.channel;
  }
  if (Object.hasOwn(failureDestination, "to")) {
    nextFailureDestination.to = failureDestination.to;
  }
  if (Object.hasOwn(failureDestination, "accountId")) {
    nextFailureDestination.accountId = failureDestination.accountId;
  }
  if (Object.hasOwn(failureDestination, "mode")) {
    nextFailureDestination.mode = failureDestination.mode;
  }
  delivery.failureDestination = nextFailureDestination;
  return {
    ...configJob,
    delivery,
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
    // Legacy rows omitted deleteAfterRun entirely; avoid writing the default
    // back into job_json so config round-trips stay byte-light.
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

/** Fails before replacing SQLite rows when any config job cannot round-trip. */
export function assertCronStoreCanPersist(store: CronStoreFile): void {
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

function rowToCronJob(row: CronJobRow): CronJob | null {
  const schedule = scheduleFromRow(row);
  const payload = payloadFromRow(row);
  const delivery = deliveryFromRow(row);
  const failureAlert = failureAlertFromRow(row);
  if (!schedule || !payload) {
    return null;
  }
  const createdAtMs = normalizeNumber(row.created_at_ms) ?? Date.now();
  return {
    id: row.job_id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.enabled !== 0,
    ...(row.delete_after_run != null
      ? { deleteAfterRun: integerToBoolean(row.delete_after_run) }
      : {}),
    createdAtMs,
    updatedAtMs:
      normalizeNumber(row.runtime_updated_at_ms) ?? normalizeNumber(row.updated_at) ?? createdAtMs,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    schedule,
    sessionTarget: row.session_target as CronJob["sessionTarget"],
    wakeMode: row.wake_mode as CronJob["wakeMode"],
    payload,
    ...(delivery ? { delivery } : {}),
    ...(failureAlert !== undefined ? { failureAlert } : {}),
    state: stateFromRow(row),
  };
}

/** Loads cron rows in config order with deterministic fallbacks for old rows. */
export function loadCronRows(db: DatabaseSync, storeKey: string): CronJobRow[] {
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

/** Replaces all persisted cron rows for one store key from the config store snapshot. */
export function replaceCronRows(db: DatabaseSync, storeKey: string, store: CronStoreFile): void {
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

/** Updates only mutable runtime columns without rewriting full job config JSON. */
export function updateCronRuntimeRows(
  db: DatabaseSync,
  storeKey: string,
  store: CronStoreFile,
): void {
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

/** Reconstructs loaded cron store data and config-runtime sidecars from SQLite rows. */
export function loadedCronStoreFromRows(rows: CronJobRow[]): LoadedCronStore {
  const parsedJobs = rows.map(rowToCronJob);
  const jobs = parsedJobs.filter((job): job is CronJob => job !== null);
  const configJobs = rows.map((row, index) =>
    mergeFailureDestinationProjection(
      parseJsonObject<Record<string, unknown>>(
        row.job_json,
        stripJobRuntimeFields(parsedJobs[index] ?? ({} as CronJob)),
      ),
      parsedJobs[index] ?? null,
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
