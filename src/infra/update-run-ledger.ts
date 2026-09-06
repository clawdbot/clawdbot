import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB, UpdateRuns } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { UpdateRunRecord, UpdateRunPhase, UpdateRunStep } from "./update-run-record.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";

const JSON_BYTES = 16 * 1024;
const RETAINED_STEP_NAMES = [
  ...UPDATE_RUN_PHASES,
  "notice:ack",
  "notice:activating",
  "notice:verifying",
];
const JSON_FIELDS = [
  "origin",
  "target",
  "before",
  "after",
  "steps",
  "verification",
  "repair",
] as const;
type LedgerDatabase = Pick<DB, "update_runs">;
type LedgerOptions = OpenClawStateDatabaseOptions & { redactPaths?: readonly string[] };
type RunPatch = Partial<
  Pick<UpdateRunRecord, "origin" | "target" | "before" | "after" | "trigger">
>;

function mapJsonText(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === "string") {
    return transform(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapJsonText(entry, transform));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, mapJsonText(value[key], transform)]),
    );
  }
  return value;
}

function isRetainedStep(item: unknown): boolean {
  return isRecord(item) && RETAINED_STEP_NAMES.some((name) => name === item.step);
}

/** Phase history and notice custody survive diagnostic eviction, so final delivery stays eligible. */
function boundedJson(input: unknown): string {
  let value = input;
  let json = JSON.stringify(value);
  while (Buffer.byteLength(json) > JSON_BYTES) {
    if (Array.isArray(value)) {
      const disposable = value.findIndex((item) => !isRetainedStep(item));
      if (disposable >= 0) {
        value = value.toSpliced(disposable, 1);
      } else {
        // Phase history and notice custody fit; discard optional diagnostics
        // before losing the identities that keep final delivery eligible.
        value = value.map((item) => (isRecord(item) ? { ...item, detail: undefined } : item));
      }
    } else if (isRecord(value)) {
      const object = value;
      const key = Object.keys(object)
        .toSorted()
        .find((field) => Array.isArray(object[field]) && object[field].length > 0);
      const array = key ? object[key] : undefined;
      if (key && Array.isArray(array)) {
        value = { ...object, [key]: array.slice(1) };
      } else {
        value = mapJsonText(value, (text) => truncateUtf16Safe(text, Math.floor(text.length / 2)));
      }
    } else {
      throw new Error("Update run metadata exceeds its bounded schema");
    }
    json = JSON.stringify(value);
  }
  return json;
}

function encodeRun(input: UpdateRunRecord, options: LedgerOptions): UpdateRuns {
  const env = options.env ?? process.env;
  // Home-relative selectors remain actionable in reports. Other captured roots
  // are diagnostic only; model refs, slash commands, and URLs are not paths.
  const roots: [string | undefined, string][] = [
    [resolveRequiredHomeDir(env), "~"],
    [env.HOME, "~"],
    [env.USERPROFILE, "~"],
    [resolveStateDir(env), "$OPENCLAW_STATE_DIR"],
    [env.OPENCLAW_CONFIG_PATH, "[path]"],
    ...(options.redactPaths ?? []).map((root): [string, string] => [root, "[path]"]),
  ];
  const redactPaths: [RegExp, string][] = roots.flatMap(([root, replacement]) => {
    if (!root) {
      return [];
    }
    const prefix = root
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "")
      .split("/")
      .map(escapeRegExp)
      .join("[\\\\/]");
    const flags = /^(?:[A-Za-z]:|\\\\)/u.test(root) ? "giu" : "gu";
    return prefix
      ? [
          [
            new RegExp(
              `(?<!https?:)(?:(?<![\\w/])|(?<=file:///?))${prefix}(?=$|[\\\\/\\s"'<>.,;:)])`,
              flags,
            ),
            replacement,
          ],
        ]
      : [];
  });
  const record = UpdateRunRecordSchema.parse(
    mapJsonText(input, (value) => {
      let text = redactSensitiveText(value, { mode: "tools" });
      for (const [pattern, replacement] of redactPaths) {
        text = text.replace(pattern, () => replacement);
      }
      return truncateUtf16Safe(text, 1024);
    }),
  );
  return {
    run_id: record.runId,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
    trigger: record.trigger,
    phase: record.phase,
    status: record.status,
    reason: record.reason,
    origin_json: boundedJson(record.origin),
    target_json: boundedJson(record.target),
    before_json: boundedJson(record.before),
    after_json: boundedJson(record.after),
    steps_json: boundedJson(record.steps),
    verification_json: boundedJson(record.verification),
    repair_json: boundedJson(record.repair),
    confirmed_at_ms: record.confirmedAtMs,
    finished_at_ms: record.finishedAtMs,
    downtime_ms: record.downtimeMs,
  };
}

function decodeRun(row: UpdateRuns): UpdateRunRecord {
  const metadata = Object.fromEntries(
    JSON_FIELDS.map((field) => [field, JSON.parse(row[`${field}_json`])]),
  );
  return UpdateRunRecordSchema.parse({
    ...metadata,
    runId: row.run_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    trigger: row.trigger,
    phase: row.phase,
    status: row.status,
    reason: row.reason,
    confirmedAtMs: row.confirmed_at_ms,
    finishedAtMs: row.finished_at_ms,
    downtimeMs: row.downtime_ms,
  });
}

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
    record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
    const row = encodeRun(record, options);
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<LedgerDatabase>(db)
        .updateTable("update_runs")
        .set(row)
        .where("run_id", "=", runId),
    );
    return decodeRun(row);
  }, options);
}

export function createUpdateRun(
  input: RunPatch & { runId?: string; trigger: UpdateRunRecord["trigger"] },
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
    record.steps.splice(disposable, 1);
  }
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
      if (
        phase !== "finished" &&
        UPDATE_RUN_PHASES.indexOf(phase) > UPDATE_RUN_PHASES.indexOf(record.phase)
      ) {
        const now = Date.now();
        upsertStep(record, { step: record.phase, status: "completed", endedAtMs: now });
        record.phase = phase;
        upsertStep(record, { step: phase, status: "in_progress", startedAtMs: now });
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
  return mutateRun(
    runId,
    (record) => {
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
    },
    options,
  );
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
      if (
        record.verification.serviceRunning &&
        record.verification.versionMatch &&
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
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => (tableExists(db, "update_runs") ? readRun(db, runId) : undefined),
    options,
  );
}

export function listUpdateRuns(
  input: { limit?: number; active?: boolean } = {},
  options: OpenClawStateDatabaseOptions = {},
): UpdateRunRecord[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
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
