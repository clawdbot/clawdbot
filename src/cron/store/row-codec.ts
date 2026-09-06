/** Converts cron jobs between public store shape and normalized SQLite rows. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import { getInvalidPersistedCronJobReason } from "../persisted-shape.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import {
  normalizeCronToolsAllowExecTarget,
  normalizeCronToolsAllowExecTargetRequirement,
  restoreCronPinnedExecGrant,
  stripCronPinnedExecGrant,
} from "../scheduled-tool-policy.js";
import type { CronJobState, CronStoredJob, CronStoreFile } from "../types.js";
import { deliveryFromJson, deliveryToJson } from "./delivery-codec.js";
import { normalizeNumber, tryParseJsonObject } from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";
import { getCronStoreKysely } from "./schema.js";
import type { LoadedCronStore } from "./types.js";

function stripJobRuntimeFields(job: CronStoreFile["jobs"][number]): Record<string, unknown> {
  const {
    runtimeAuthority: _runtimeAuthority,
    runtimeAuthorityRecoveryRequired: _runtimeAuthorityRecoveryRequired,
    state: _state,
    updatedAtMs: _updatedAtMs,
    ...rest
  } = job;
  const payload = isRecord(rest.payload) ? rest.payload : undefined;
  const toolsAllow = Array.isArray(payload?.toolsAllow)
    ? payload.toolsAllow.filter((tool): tool is string => typeof tool === "string")
    : undefined;
  const storedToolsAllow = stripCronPinnedExecGrant({
    toolsAllow,
    requirement: rest.toolsAllowExecTargetRequirement,
  });
  // Runtime state and authority have separate owners; JSON is canonical for config.
  return {
    ...rest,
    ...(payload && storedToolsAllow
      ? { payload: { ...payload, toolsAllow: storedToolsAllow } }
      : {}),
    ...(rest.delivery ? { delivery: deliveryToJson(rest.delivery) } : {}),
    state: {},
  };
}

function serializeCronJobState(state: CronJobState): string {
  return JSON.stringify({
    ...state,
    ...(state.lastRunStatus === undefined && state.lastStatus !== undefined
      ? { lastRunStatus: state.lastStatus }
      : {}),
  });
}

function bindCronJobRow(storeKey: string, job: CronStoredJob, sortOrder: number): CronJobInsert {
  return {
    store_key: storeKey,
    job_id: job.id,
    declaration_key: job.declarationKey ?? null,
    owner_agent_id: job.owner?.agentId ?? null,
    name: job.name,
    description: job.description ?? null,
    enabled: job.enabled ? 1 : 0,
    updated_at: job.updatedAtMs,
    agent_id: job.agentId ?? null,
    payload_kind: job.payload.kind,
    job_json: JSON.stringify(stripJobRuntimeFields(job)),
    state_json: serializeCronJobState(job.state ?? {}),
    runtime_updated_at_ms: job.updatedAtMs,
    schedule_identity: tryCronScheduleIdentity({ ...job }) ?? null,
    sort_order: sortOrder,
  };
}

function normalizeCronJobForSqlite(job: CronStoreFile["jobs"][number]): CronStoredJob | null {
  const raw: Record<string, unknown> = { ...structuredClone(job) };
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
  } as CronStoredJob;
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

function decodeCronJobConfig(jobJson: Record<string, unknown>): Record<string, unknown> {
  const delivery = deliveryFromJson(jobJson.delivery);
  return delivery ? { ...jobJson, delivery } : jobJson;
}

function rowToCronJob(row: CronJobRow, jobJson: Record<string, unknown>): CronStoredJob | null {
  const state = tryParseJsonObject(row.state_json);
  if (!state || getInvalidPersistedCronJobReason(jobJson)) {
    return null;
  }
  const toolsAllowExecTarget = normalizeCronToolsAllowExecTarget(jobJson.toolsAllowExecTarget);
  const toolsAllowExecTargetRequirement = normalizeCronToolsAllowExecTargetRequirement(
    jobJson.toolsAllowExecTargetRequirement,
  );
  const createdAtMs =
    typeof jobJson.createdAtMs === "number" && Number.isFinite(jobJson.createdAtMs)
      ? jobJson.createdAtMs
      : Date.now();
  // Doctor retains unresolved legacy markers in config JSON; runtime never consumes them.
  const {
    notify: _legacyNotify,
    toolsAllowExecTarget: _rawToolsAllowExecTarget,
    toolsAllowExecTargetRequirement: _rawToolsAllowExecTargetRequirement,
    ...runtimeConfig
  } = decodeCronJobConfig(jobJson);
  const payload = isRecord(runtimeConfig.payload) ? runtimeConfig.payload : undefined;
  const toolsAllow = Array.isArray(payload?.toolsAllow)
    ? payload.toolsAllow.filter((tool): tool is string => typeof tool === "string")
    : undefined;
  const runtimeToolsAllow = restoreCronPinnedExecGrant({
    toolsAllow,
    requirement: toolsAllowExecTargetRequirement,
    execTarget: toolsAllowExecTarget,
  });
  if (payload && runtimeToolsAllow) {
    runtimeConfig.payload = { ...payload, toolsAllow: runtimeToolsAllow };
  }
  if (isRecord(runtimeConfig.delivery) && runtimeConfig.delivery.mode === undefined) {
    // Legacy destination-only config remains untouched for doctor; runtime defaults to announce.
    runtimeConfig.delivery = deliveryFromJson({ ...runtimeConfig.delivery, mode: "announce" });
  }
  return {
    ...runtimeConfig,
    id: row.job_id,
    ...(toolsAllowExecTarget ? { toolsAllowExecTarget } : {}),
    ...(toolsAllowExecTargetRequirement ? { toolsAllowExecTargetRequirement } : {}),
    createdAtMs,
    updatedAtMs:
      normalizeNumber(row.runtime_updated_at_ms) ?? normalizeNumber(row.updated_at) ?? createdAtMs,
    state,
  } as CronStoredJob;
}

/** Projects a live job through the same normalization/codecs used by SQLite persistence. */
export function projectCronJobThroughStorageCodec(job: CronStoredJob): CronStoredJob {
  const normalized = normalizeCronJobForSqlite(job);
  if (!normalized) {
    throw new Error(`cannot project invalid cron job ${job.id}`);
  }
  const row = bindCronJobRow("config-revision", normalized, 0) as CronJobRow;
  const projected = rowToCronJob(row, tryParseJsonObject(row.job_json) ?? {});
  if (!projected) {
    throw new Error(`cannot project cron job ${job.id} through storage codecs`);
  }
  return projected;
}

/** Loads cron rows in config order with deterministic fallbacks for old rows. */
export function loadCronRows(
  db: DatabaseSync,
  storeKey: string,
  jobIds?: ReadonlySet<string>,
): CronJobRow[] {
  let query = getCronStoreKysely(db)
    .selectFrom("cron_jobs")
    .selectAll()
    .where("store_key", "=", storeKey)
    .orderBy("sort_order", "asc")
    .orderBy("updated_at", "asc")
    .orderBy("job_id", "asc");
  if (jobIds) {
    const ids = [...jobIds];
    query =
      ids.length === 1
        ? query.where("job_id", "=", ids[0]!)
        : query.where("job_id", "in", sqliteStringSet(ids));
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  // SQLite replaces lone surrogates in bound IDs; keep exact caller identity
  // so an invalid ID cannot select the replacement-character job.
  return jobIds ? rows.filter((row) => jobIds.has(row.job_id)) : rows;
}

/** Fingerprints raw definition rows without mutating their config order. */
export function fingerprintCronJobRows(
  rows: readonly Pick<CronJobRow, "job_id" | "job_json" | "sort_order">[],
): string {
  // This internal, transient Doctor token uses one encoding-independent ID order.
  // Keep raw fields so every definition edit invalidates the snapshot.
  const ordered = rows
    .map(({ job_id, job_json, sort_order }) => ({
      idBytes: Buffer.from(job_id),
      definition: { job_id, job_json, sort_order },
    }))
    .toSorted((left, right) => Buffer.compare(left.idBytes, right.idBytes));
  return sha256Hex(JSON.stringify(ordered.map(({ definition }) => definition)));
}

/** Reads only definition JSON and order while excluding runtime-owned state. */
export function readCronJobsFingerprint(db: DatabaseSync, storeKey: string): string {
  const rows = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["job_id", "job_json", "sort_order"])
      .where("store_key", "=", storeKey),
  ).rows;
  return fingerprintCronJobRows(rows);
}

/** Materializes retired ownership within the caller's write transaction. */
export function materializeCronRowAgentOwners(
  db: DatabaseSync,
  storeKey: string,
  legacyDefaultAgentId: string,
): number {
  const agentId = normalizeAgentId(legacyDefaultAgentId);
  let rewritten = 0;
  for (const row of loadCronRows(db, storeKey)) {
    const jobJson = tryParseJsonObject(row.job_json);
    const jsonSessionAgentId = parseAgentSessionKey(
      normalizeOptionalString(jobJson?.sessionKey),
    )?.agentId;
    if (
      normalizeOptionalString(row.agent_id) ||
      normalizeOptionalString(jobJson?.agentId) ||
      jsonSessionAgentId
    ) {
      continue;
    }
    if (jobJson) {
      jobJson.agentId = agentId;
    }
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .updateTable("cron_jobs")
        .set({
          agent_id: agentId,
          ...(jobJson ? { job_json: JSON.stringify(jobJson) } : {}),
        })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", row.job_id),
    );
    rewritten += 1;
  }
  return rewritten;
}

export type CronJobFamilyIdentity = {
  declarationKey: string;
  name: string;
  ownerPluginTag: string;
};

/** Removes one owned job family from obsolete store partitions. */
export function deleteStaleCronJobFamilyRows(
  db: DatabaseSync,
  activeStoreKey: string,
  family: CronJobFamilyIdentity,
): number {
  const staleRows = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["store_key", "job_id", "declaration_key", "name", "description"])
      .where("store_key", "!=", activeStoreKey),
  ).rows.filter(
    (row) =>
      row.declaration_key === family.declarationKey ||
      (row.name === family.name && row.description?.includes(family.ownerPluginTag) === true),
  );
  for (const row of staleRows) {
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .deleteFrom("cron_job_scratch")
        .where("store_key", "=", row.store_key)
        .where("job_id", "=", row.job_id),
    );
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .deleteFrom("cron_jobs")
        .where("store_key", "=", row.store_key)
        .where("job_id", "=", row.job_id),
    );
  }
  return staleRows.length;
}

/** Replaces all persisted cron rows and returns the canonical jobs that were written. */
type CronRowReplaceOptions = {
  preserveRuntimeState?: boolean;
};

type CronRowReplaceResult = {
  existingJobIds: ReadonlySet<string>;
  jobs: CronStoredJob[];
  legacyAuthorityJobIds: ReadonlySet<string>;
};

export function replaceCronRows(
  db: DatabaseSync,
  storeKey: string,
  store: CronStoreFile,
  opts?: CronRowReplaceOptions,
): CronRowReplaceResult {
  const existingRows = executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .select(["job_id", "job_json"])
      .where("store_key", "=", storeKey),
  ).rows;
  const normalizedJobs: CronStoredJob[] = [];
  for (const [index, job] of store.jobs.entries()) {
    normalizedJobs.push(upsertCronJobRow(db, storeKey, job, index, opts));
  }
  const nextJobIds = new Set(normalizedJobs.map((job) => job.id));
  const existingJobIds = new Set<string>();
  const legacyAuthorityJobIds = new Set<string>();
  for (const row of existingRows) {
    existingJobIds.add(row.job_id);
    const storedJob = tryParseJsonObject(row.job_json);
    if (
      storedJob &&
      (Object.hasOwn(storedJob, "runtimeAuthority") ||
        Object.hasOwn(storedJob, "runtimeAuthorityRecoveryRequired"))
    ) {
      legacyAuthorityJobIds.add(row.job_id);
    }
    if (nextJobIds.has(row.job_id)) {
      continue;
    }
    // Reconcile removed jobs only; deleting the partition first rewrites every
    // unrelated row and defeats SQLite's row-owned cron storage boundary.
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .deleteFrom("cron_jobs")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", row.job_id),
    );
  }
  return { existingJobIds, jobs: normalizedJobs, legacyAuthorityJobIds };
}

/** Upserts one persisted cron row without rewriting unrelated jobs in its store partition. */
export function upsertCronJobRow(
  db: DatabaseSync,
  storeKey: string,
  job: CronStoredJob,
  sortOrder: number,
  opts?: CronRowReplaceOptions,
): CronStoredJob {
  const normalized = normalizeCronJobForSqlite(job);
  if (!normalized) {
    throw new Error(`Cannot persist invalid cron job ${job.id}`);
  }
  const values = bindCronJobRow(storeKey, normalized, sortOrder);
  const {
    state_json: _stateJson,
    runtime_updated_at_ms: _runtimeUpdatedAtMs,
    ...definitionValues
  } = values;
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .insertInto("cron_jobs")
      .values(values)
      .onConflict((conflict) =>
        conflict
          .columns(["store_key", "job_id"])
          .doUpdateSet(opts?.preserveRuntimeState ? definitionValues : values),
      ),
  );
  return normalized;
}

export function deleteCronJobRowInDatabase(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
): void {
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .deleteFrom("cron_job_scratch")
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  );
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .deleteFrom("cron_jobs")
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  );
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
          state_json: serializeCronJobState(job.state ?? {}),
          runtime_updated_at_ms: job.updatedAtMs,
          schedule_identity: tryCronScheduleIdentity({ ...job }),
        })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", job.id),
    );
  }
}

/** Reconstructs loaded cron store data and config-runtime sidecars from SQLite rows. */
export function loadedCronStoreFromRows(rows: CronJobRow[]): LoadedCronStore {
  const jobs: CronStoredJob[] = [];
  const configJobs: LoadedCronStore["configJobs"] = [];
  const configJobIndexes: number[] = [];
  const configJobRuntimeEntries: LoadedCronStore["configJobRuntimeEntries"] = [];
  const invalidConfigRows: LoadedCronStore["invalidConfigRows"] = [];

  for (const [index, row] of rows.entries()) {
    const parsedJobJson = tryParseJsonObject(row.job_json);
    const parsedStateJson = tryParseJsonObject(row.state_json);
    if (!parsedJobJson || !parsedStateJson) {
      invalidConfigRows.push({
        sourceIndex: index,
        reason: parsedJobJson ? "invalid-state" : "invalid-payload",
        ...(parsedJobJson ? { job: decodeCronJobConfig(parsedJobJson) } : {}),
        raw: { jobId: row.job_id, jobJson: row.job_json, stateJson: row.state_json },
      });
      continue;
    }
    const job = rowToCronJob(row, parsedJobJson);
    const configJob = decodeCronJobConfig(parsedJobJson);
    const runtimeEntry = {
      updatedAtMs: normalizeNumber(row.runtime_updated_at_ms) ?? normalizeNumber(row.updated_at),
      scheduleIdentity: row.schedule_identity ?? undefined,
      state: parsedStateJson,
    };

    if (!job) {
      invalidConfigRows.push({
        sourceIndex: index,
        reason: getInvalidPersistedCronJobReason(configJob) ?? "invalid-payload",
        job: configJob,
        ...(runtimeEntry.state ? { state: runtimeEntry.state } : {}),
        ...(runtimeEntry.updatedAtMs !== undefined
          ? { updatedAtMs: runtimeEntry.updatedAtMs }
          : {}),
        ...(runtimeEntry.scheduleIdentity !== undefined
          ? { scheduleIdentity: runtimeEntry.scheduleIdentity }
          : {}),
      });
      continue;
    }

    // Every surviving job keeps the config, runtime state, and source index
    // from its own SQLite row even when an earlier row cannot be projected.
    jobs.push(job);
    configJobs.push(configJob);
    configJobIndexes.push(index);
    configJobRuntimeEntries.push(runtimeEntry);
  }

  return {
    store: { version: 1, jobs },
    configJobs,
    configJobIndexes,
    configJobRuntimeEntries,
    invalidConfigRows,
  };
}
