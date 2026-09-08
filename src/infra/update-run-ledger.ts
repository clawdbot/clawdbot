import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  UPDATE_RUN_DRIVER_LIMIT,
  UPDATE_RUN_PHASES,
} from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  inspectUpdateRunAbandonment,
  isStaleIdentitylessUpdateRun,
  recordedUpdateRunDrivers,
} from "./update-run-activity.js";
import {
  decodeRun,
  encodeRun,
  isRetainedStep,
  type UpdateRunLedgerOptions as LedgerOptions,
} from "./update-run-codec.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
  type UpdateRunDriver,
} from "./update-run-driver.js";
import type { UpdateRunRecord, UpdateRunPhase, UpdateRunStep } from "./update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "./update-run-timeouts.js";

type LedgerDatabase = Pick<DB, "update_runs">;
type RunPatch = Partial<
  Pick<UpdateRunRecord, "origin" | "target" | "before" | "after" | "trigger">
>;

const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS update_runs (");
const schemaEndMarker = "ON update_runs(status, created_at_ms DESC, run_id);";
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(schemaEndMarker, schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Update run schema markers are missing");
}
const schema = OPENCLAW_STATE_SCHEMA_SQL.slice(schemaStart, schemaEnd + schemaEndMarker.length);
const readyDatabases = new WeakSet<DatabaseSync>();

function readRun(db: DatabaseSync, runId: string): UpdateRunRecord | undefined {
  const query = getNodeSqliteKysely<LedgerDatabase>(db)
    .selectFrom("update_runs")
    .selectAll()
    .where("run_id", "=", runId);
  const row = executeSqliteQueryTakeFirstSync(db, query);
  return row ? decodeRun(row) : undefined;
}

function writeRun<T>(operation: (db: DatabaseSync) => T, options: OpenClawStateDatabaseOptions): T {
  let committedDatabase: DatabaseSync | undefined;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Feature-local, idempotent DDL shares the write transaction; a failed write also rolls back first use.
      if (!readyDatabases.has(db)) {
        db.exec(schema); // sqlite-allow-raw -- Canonical lazy additive DDL bootstrap only.
      }
      committedDatabase = db;
      return operation(db);
    },
    options,
    { operationLabel: "update.run" },
  );
  if (committedDatabase && !committedDatabase.isTransaction) {
    readyDatabases.add(committedDatabase);
  }
  return result;
}

function persistRun(
  db: DatabaseSync,
  record: UpdateRunRecord,
  options: LedgerOptions,
): UpdateRunRecord {
  record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
  const row = encodeRun(record, options);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<LedgerDatabase>(db)
      .updateTable("update_runs")
      .set(row)
      .where("run_id", "=", record.runId),
  );
  return decodeRun(row);
}

function mutateRun(
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: LedgerOptions,
): UpdateRunRecord {
  return writeRun((db) => {
    const record = readRun(db, runId);
    if (!record) {
      throw new Error(`Unknown update run: ${runId}`);
    }
    const before = JSON.stringify(record);
    update(record);
    if (before === JSON.stringify(record)) {
      return record;
    }
    return persistRun(db, record, options);
  }, options);
}

export function createUpdateRun(
  input: RunPatch & {
    runId?: string;
    trigger: UpdateRunRecord["trigger"];
    supersedeStaleIdentityless?: boolean;
  },
  options: LedgerOptions = {},
): UpdateRunRecord {
  const now = Date.now();
  const row = encodeRun(
    {
      runId: input.runId ?? randomUUID(),
      createdAtMs: now,
      updatedAtMs: now,
      trigger: input.trigger,
      phase: "requested",
      status: "running",
      reason: null,
      origin: input.origin ?? {},
      target: input.target ?? {},
      before: input.before ?? {},
      after: {},
      steps: [{ step: "requested", status: "in_progress", startedAtMs: now }],
      verification: {},
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: null,
      downtimeMs: null,
    },
    options,
  );
  return writeRun((db) => {
    const existing = readRun(db, row.run_id);
    if (existing) {
      return existing;
    }
    // Only an explicit new CLI invocation may supersede the single legacy run.
    // Selection, activity recheck, terminalization, and admission share this transaction.
    if (input.supersedeStaleIdentityless && !input.runId && input.trigger === "cli") {
      const active = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<LedgerDatabase>(db)
          .selectFrom("update_runs")
          .selectAll()
          .where("status", "=", "running")
          .limit(2),
      ).rows;
      const previous = active.length === 1 && active[0] ? decodeRun(active[0]) : undefined;
      if (previous && isStaleIdentitylessUpdateRun(previous)) {
        upsertStep(previous, {
          step: "reconcile:superseded",
          status: "failed",
          endedAtMs: now,
          detail: "operator-started-update-supersedes-inactive-identityless-run",
        });
        finishRunRecord(previous, { status: "failed", reason: "superseded" });
        persistRun(db, previous, options);
      }
    }
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<LedgerDatabase>(db).insertInto("update_runs").values(row),
    );
    return decodeRun(row);
  }, options);
}

function upsertStep(record: UpdateRunRecord, step: UpdateRunStep): void {
  const index = record.steps.findIndex((existing) => existing.step === step.step);
  if (index >= 0) {
    record.steps[index] = { ...record.steps[index], ...step };
  } else {
    record.steps.push(step);
  }
  while (record.steps.length > 128) {
    const disposable = record.steps.findIndex((entry) => !isRetainedStep(entry));
    if (disposable < 0) {
      throw new Error("Update run retained steps exceed the step limit");
    }
    record.steps.splice(disposable, 1);
  }
}

/** Adoption is explicit: reading or reserving an existing run does not make this process its driver. */
export function adoptUpdateRun(runId: string, options: LedgerOptions = {}): UpdateRunRecord {
  const driver = readUpdateRunDriver();
  let identityUnavailable = false;
  const adopted = mutateRun(
    runId,
    (record) => {
      if (record.status !== "running") {
        throw new Error(`Update run ${runId} is already ${record.status}; it cannot be adopted.`);
      }
      if (!driver) {
        if (!record.steps.some((step) => step.step === "driver:identity-unavailable")) {
          // Retain known parents, but their death cannot prove this adopter exited.
          upsertStep(record, {
            step: "driver:identity-unavailable",
            status: "completed",
            endedAtMs: Date.now(),
          });
          identityUnavailable = true;
        }
        return;
      }
      const previousDrivers: UpdateRunDriver[] = [];
      for (const previous of recordedUpdateRunDrivers(record)) {
        if (
          !sameUpdateRunDriver(previous, driver) &&
          !previousDrivers.some((retained) => sameUpdateRunDriver(retained, previous)) &&
          inspectUpdateRunDriver(previous) !== "dead"
        ) {
          previousDrivers.push(previous);
        }
      }
      if (previousDrivers.length >= UPDATE_RUN_DRIVER_LIMIT) {
        throw new Error(
          `Update run ${runId} has too many live or unobservable drivers; adoption refused.`,
        );
      }
      const retained = record.origin.previousDrivers ?? [];
      if (
        record.origin.driver &&
        sameUpdateRunDriver(record.origin.driver, driver) &&
        record.steps.some((step) => step.step === "driver:adopted") &&
        retained.length === previousDrivers.length &&
        retained.every((previous, index) => {
          const next = previousDrivers[index];
          return next !== undefined && sameUpdateRunDriver(previous, next);
        })
      ) {
        return;
      }
      record.origin.driver = driver;
      record.origin.previousDrivers = previousDrivers.length ? previousDrivers : undefined;
      upsertStep(record, { step: "driver:adopted", status: "completed", endedAtMs: Date.now() });
    },
    options,
  );
  if (identityUnavailable) {
    console.warn(
      "[update] Driver identity recording is unavailable. The update will continue; this run requires explicit recovery if it stops reporting progress.",
    );
  }
  return adopted;
}

/** Retained orchestrators can renew their children; pruned identities cannot. */
export function heartbeatUpdateRun(
  runId: string,
  driver: UpdateRunDriver | undefined,
  options: LedgerOptions = {},
): void {
  if (!driver) {
    return;
  }
  mutateRun(
    runId,
    (record) => {
      if (
        record.status === "running" &&
        recordedUpdateRunDrivers(record).some((current) => sameUpdateRunDriver(current, driver))
      ) {
        record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
      }
    },
    options,
  );
}

/** Record the operator's successful ledger-only repair without changing the failed outcome. */
export function acknowledgeAbandonedUpdateRun(runId: string, options: LedgerOptions = {}): void {
  mutateRun(
    runId,
    (record) => {
      if (
        record.status === "failed" &&
        record.reason === "abandoned" &&
        !record.steps.some((step) => step.step === "reconcile:acknowledged")
      ) {
        upsertStep(record, {
          step: "reconcile:acknowledged",
          status: "completed",
          endedAtMs: Date.now(),
        });
      }
    },
    options,
  );
}

/** The writer rechecks activity and process identity in the same transaction as terminalization. */
export function reconcileAbandonedUpdateRuns(
  input: { explicit?: boolean; runIds?: readonly string[]; requireAllActive?: boolean } = {},
  options: LedgerOptions = {},
): UpdateRunRecord[] {
  if (input.runIds?.length === 0) {
    return [];
  }
  const candidates =
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
      if (!tableExists(db, "update_runs")) {
        return [];
      }
      let query = getNodeSqliteKysely<LedgerDatabase>(db)
        .selectFrom("update_runs")
        .select("run_id")
        .where("status", "=", "running");
      if (!input.explicit) {
        query = query.where("updated_at_ms", "<", Date.now() - ABANDONED_UPDATE_RUN_MS);
      }
      if (input.runIds) {
        query = query.where("run_id", "in", [...input.runIds]);
      }
      return executeSqliteQuerySync(db, query.orderBy("run_id")).rows;
    }, options) ?? [];
  if (!candidates.length) {
    return [];
  }
  return writeRun((db) => {
    if (
      input.requireAllActive &&
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<LedgerDatabase>(db)
          .selectFrom("update_runs")
          .select("run_id")
          .where("status", "=", "running")
          .where(
            "run_id",
            "not in",
            candidates.map((candidate) => candidate.run_id),
          )
          .limit(1),
      )
    ) {
      return [];
    }
    const selected = candidates.flatMap((candidate) => {
      const record = readRun(db, candidate.run_id);
      return record?.status === "running"
        ? [{ record, rule: inspectUpdateRunAbandonment(record, input) }]
        : [];
    });
    // Operator recovery is one selection: renewed activity preserves every selected row.
    if (input.explicit && selected.some(({ rule }) => !rule)) {
      return [];
    }
    return selected.flatMap(({ record, rule }) => {
      if (!rule) {
        return [];
      }
      upsertStep(record, {
        step: "reconcile:abandoned",
        status: "failed",
        endedAtMs: Date.now(),
        detail: rule,
      });
      finishRunRecord(record, { status: "failed", reason: "abandoned" });
      return [persistRun(db, record, options)];
    });
  }, options);
}

export function recordUpdateRunPhase(
  runId: string,
  phase: UpdateRunPhase,
  patch: RunPatch & { step?: UpdateRunStep } = {},
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      if (record.status !== "running") {
        return;
      }
      if (patch.origin) {
        record.origin = { ...record.origin, ...patch.origin };
      }
      if (patch.target) {
        record.target = { ...record.target, ...patch.target };
      }
      if (patch.before) {
        record.before = { ...record.before, ...patch.before };
      }
      if (patch.after) {
        record.after = { ...record.after, ...patch.after };
      }
      if (patch.trigger) {
        record.trigger = patch.trigger;
      }
      const repairsVerification = phase === "repairing" && record.phase === "verifying";
      const advances = UPDATE_RUN_PHASES.indexOf(phase) > UPDATE_RUN_PHASES.indexOf(record.phase);
      // Post-activation repair may only return to verification; stale staging
      // writers must not reopen activation while the live candidate is repaired.
      const resumesVerification =
        record.phase === "repairing" && record.steps.some((step) => step.step === "verifying");
      if (
        phase !== "finished" &&
        (repairsVerification || (advances && (!resumesVerification || phase === "verifying")))
      ) {
        const now = Date.now();
        upsertStep(record, { step: record.phase, status: "completed", endedAtMs: now });
        record.phase = phase;
        upsertStep(record, {
          step: phase,
          status: "in_progress",
          startedAtMs: now,
          endedAtMs: undefined,
        });
      }
      if (patch.step) {
        upsertStep(record, patch.step);
      }
    },
    options,
  );
}

export function recordUpdateRunStep(
  runId: string,
  step: UpdateRunStep,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      if (record.status === "running") {
        upsertStep(record, step);
      }
    },
    options,
  );
}

/** A terminal process diagnostic adds evidence without reopening the recorded outcome. */
export function recordUpdateRunDiagnostic(
  runId: string,
  detail: string,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      upsertStep(record, {
        step: "finalize:exit",
        status: "completed",
        endedAtMs: Date.now(),
        detail,
      });
    },
    options,
  );
}

export function finishUpdateRun(
  runId: string,
  result: {
    status: Exclude<UpdateRunRecord["status"], "running">;
    reason?: string;
    after?: UpdateRunRecord["after"];
    downtimeMs?: number;
  },
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(runId, (record) => finishRunRecord(record, result), options);
}

function finishRunRecord(
  record: UpdateRunRecord,
  result: Parameters<typeof finishUpdateRun>[1],
): void {
  // CLI and the new Gateway may finish together. The first durable terminal outcome wins.
  if (record.status !== "running") {
    return;
  }
  const now = Date.now();
  // A thrown command or interrupted updater can miss its completion callback.
  // Terminal runs cannot retain live steps after their lifecycle closes.
  for (const step of record.steps) {
    if (step.step === record.phase || step.status === "in_progress") {
      step.status =
        result.status === "failed"
          ? "failed"
          : result.status === "skipped"
            ? "skipped"
            : "completed";
      step.endedAtMs = now;
    }
  }
  record.status = result.status;
  record.phase = "finished";
  record.reason = result.reason ?? null;
  record.finishedAtMs = now;
  record.after = { ...record.after, ...result.after };
  record.downtimeMs = result.downtimeMs ?? record.downtimeMs;
}

export function recordUpdateRunVerification(
  runId: string,
  verification: UpdateRunRecord["verification"],
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      record.verification = {
        ...record.verification,
        ...verification,
        ...(verification.pluginErrors
          ? { pluginErrors: verification.pluginErrors.slice(-32) }
          : {}),
      };
      if (record.status === "running" && verification.serviceRunning === false) {
        record.confirmedAtMs = null;
      }
      if (
        record.verification.serviceRunning &&
        record.verification.versionMatch &&
        record.verification.settled === true &&
        record.verification.readyz === true &&
        record.verification.channelsReady === true &&
        record.verification.pluginErrors?.length === 0 &&
        record.confirmedAtMs === null
      ) {
        record.confirmedAtMs = Date.now();
      }
    },
    options,
  );
}

export function recordUpdateRunRepairAttempt(
  runId: string,
  attempt: UpdateRunRecord["repair"][number],
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      if (record.status !== "running") {
        return;
      }
      record.repair = [
        ...record.repair.filter((entry) => entry.attempt !== attempt.attempt),
        attempt,
      ].slice(-16);
    },
    options,
  );
}

export function getUpdateRun(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord | undefined {
  return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => (tableExists(db, "update_runs") ? readRun(db, runId) : undefined),
    options,
  );
}

export function listUpdateRuns(
  input: { limit?: number; active?: boolean } = {},
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
      if (!tableExists(db, "update_runs")) {
        return [];
      }
      let query = getNodeSqliteKysely<LedgerDatabase>(db).selectFrom("update_runs").selectAll();
      if (input.active) {
        query = query.where("status", "=", "running");
      }
      return executeSqliteQuerySync(
        db,
        query
          .orderBy("created_at_ms", "desc")
          .orderBy("run_id", "desc")
          .limit(Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))),
      ).rows.map(decodeRun);
    }, options) ?? []
  );
}

export function findActiveUpdateRun(
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord | undefined {
  return listUpdateRuns({ limit: 1, active: true }, options)[0];
}
