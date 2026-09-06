import type { SQLInputValue } from "node:sqlite";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { Selectable } from "kysely";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob } from "../cron/types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export const CLAW_CRON_REF_SCHEMA_VERSION = "openclaw.clawCronRef.v1" as const;

export type PersistedClawCronRef = {
  schemaVersion: typeof CLAW_CRON_REF_SCHEMA_VERSION;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed" | "removed";
  job: ClawCronJob;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type CronRefDatabase = Pick<DB, "claw_cron_refs">;
type CronRefRow = Selectable<CronRefDatabase["claw_cron_refs"]>;

export type ClawCronGateway = {
  add: (input: Record<string, unknown>) => Promise<unknown>;
  get?: (schedulerJobId: string) => Promise<unknown>;
  list?: (agentId: string) => Promise<unknown>;
  remove: (schedulerJobId: string) => Promise<unknown>;
  waitUntilAgentAvailable?: (agentId: string) => Promise<void>;
};

export class ClawCronInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cronJobs: PersistedClawCronRef[],
  ) {
    super(message);
    this.name = "ClawCronInstallError";
  }
}

function rowToRef(row: CronRefRow): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    manifestId: row.manifest_id,
    declarationKey: row.declaration_key,
    ...(row.scheduler_job_id ? { schedulerJobId: row.scheduler_job_id } : {}),
    // SAFETY: Lifecycle writers own the existing persisted status enum.
    status: row.status as PersistedClawCronRef["status"],
    job: JSON.parse(row.job_json) as ClawCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

function refToRow(ref: PersistedClawCronRef): CronRefRow {
  return {
    schema_version: ref.schemaVersion,
    agent_id: ref.agentId,
    manifest_id: ref.manifestId,
    declaration_key: ref.declarationKey,
    scheduler_job_id: ref.schedulerJobId ?? null,
    status: ref.status,
    job_json: JSON.stringify(ref.job),
    error: ref.error ?? null,
    created_at_ms: ref.createdAtMs,
    updated_at_ms: ref.updatedAtMs,
  };
}

function persistPendingRef(
  plan: ClawAddPlan,
  job: ClawCronJob,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  const nowMs = options.nowMs ?? Date.now();
  const declarationKey = `claw:${plan.agent.finalId}:${job.id}`;
  const database = openOpenClawStateDatabase(options);
  const query = getNodeSqliteKysely<CronRefDatabase>(database.db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .where("agent_id", "=", plan.agent.finalId)
    .where("manifest_id", "=", job.id)
    .compile();
  const existing =
    database.db /* sqlite-allow-raw: execute compiled Kysely with the existing native read error boundary. */
      .prepare(query.sql)
      // SAFETY: Compiled predicates bind strings; the canonical schema supplies the row shape.
      .get(...(query.parameters as SQLInputValue[])) as CronRefRow | undefined;
  if (existing) {
    const ref = rowToRef(existing);
    if (ref.declarationKey !== declarationKey || JSON.stringify(ref.job) !== JSON.stringify(job)) {
      throw new ClawCronInstallError(
        "cron_provenance_conflict",
        `Cron declaration ${JSON.stringify(job.id)} differs from its pending ownership record.`,
        [ref],
      );
    }
    if (ref.status === "complete") {
      return ref;
    }
    return updateRef(ref, { status: "pending" }, options);
  }
  const record: PersistedClawCronRef = {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    manifestId: job.id,
    declarationKey,
    status: "pending",
    job,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .insertInto("claw_cron_refs")
        .values(refToRow(record)),
    );
  }, options);
  return record;
}

function updateRef(
  ref: PersistedClawCronRef,
  update: { schedulerJobId?: string; status: PersistedClawCronRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  // Omitted fields are cleared in SQLite and must not survive in the returned result.
  const { schedulerJobId: _schedulerJobId, error: _error, ...retained } = ref;
  const updated = {
    ...retained,
    ...update,
    updatedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .updateTable("claw_cron_refs")
        .set({
          scheduler_job_id: updated.schedulerJobId ?? null,
          status: updated.status,
          error: updated.error ?? null,
          updated_at_ms: updated.updatedAtMs,
        })
        .where("agent_id", "=", ref.agentId)
        .where("manifest_id", "=", ref.manifestId),
    );
  }, options);
  return updated;
}

export function clawCronSchedulerJobFromResult(value: unknown): { id: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) {
    return { id: record.id };
  }
  const job = record.job;
  if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
    return { id: (job as Record<string, unknown>).id as string };
  }
  return undefined;
}

function schedulerJobRecordByDeclarationKey(
  value: unknown,
  declarationKey: string,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const jobs = (value as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) {
    return undefined;
  }
  const matches = jobs.filter(
    (job): job is Record<string, unknown> =>
      Boolean(job) &&
      typeof job === "object" &&
      (job as Record<string, unknown>).declarationKey === declarationKey &&
      typeof (job as Record<string, unknown>).id === "string",
  );
  const match = matches.length === 1 ? matches[0] : undefined;
  return match;
}

function schedulerJobByDeclarationKey(
  value: unknown,
  declarationKey: string,
): { id: string } | undefined {
  const match = schedulerJobRecordByDeclarationKey(value, declarationKey);
  return match ? { id: match.id as string } : undefined;
}

export function clawCronGatewayInput(
  agentId: string,
  ref: PersistedClawCronRef,
): Record<string, unknown> {
  const job = ref.job;
  return {
    name: job.name ?? job.id,
    declarationKey: ref.declarationKey,
    ...(job.name ? { displayName: job.name } : {}),
    owner: { agentId },
    enabled: true,
    agentId,
    schedule: {
      kind: "cron",
      expr: job.schedule.cron,
      ...(job.schedule.timezone ? { tz: job.schedule.timezone } : {}),
    },
    sessionTarget: job.session === "main" ? `session:agent:${agentId}:main` : job.session,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.message },
    delivery: job.delivery
      ? {
          mode: job.delivery.mode,
          ...(job.delivery.channel ? { channel: job.delivery.channel } : {}),
        }
      : { mode: "none" },
  };
}

export function clawCronGatewayJobMatchesRef(
  agentId: string,
  ref: PersistedClawCronRef,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const live = cronJobDefinitionFromReadView(value as Partial<CronJob>);
  const expected = normalizeCronJobCreate(clawCronGatewayInput(agentId, ref));
  if (
    !expected ||
    typeof live.id !== "string" ||
    typeof live.createdAtMs !== "number" ||
    typeof live.updatedAtMs !== "number" ||
    !live.state
  ) {
    return false;
  }
  const comparableLive = { ...live, payload: { ...live.payload } } as CronJob;
  applyDefaultCronToolsAllow(expected);
  applyDefaultCronToolsAllow(comparableLive);
  const expectedWithPolicy = {
    ...expected,
    ...(comparableLive.scheduledToolPolicy
      ? { scheduledToolPolicy: createTrustedCronScheduledToolPolicy() }
      : {}),
  };
  try {
    return (
      resolveCronJobConfigRevision({
        ...expectedWithPolicy,
        id: live.id,
        createdAtMs: live.createdAtMs,
        updatedAtMs: live.updatedAtMs,
        state: live.state,
      }) === resolveCronJobConfigRevision(comparableLive)
    );
  } catch {
    return false;
  }
}

export async function installClawCronJobs(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    gateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
    nowMs?: number;
  } = {},
): Promise<PersistedClawCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  if (!options.gateway) {
    throw new ClawCronInstallError(
      "cron_gateway_required",
      "Claw automations require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedClawCronRef[] = [];
  let agentAvailable = false;
  for (const action of actions) {
    const details = action.details as (ClawCronJob & { agentId?: string }) | undefined;
    if (!details?.id) {
      throw new ClawCronInstallError(
        "cron_plan_invalid",
        `Cron action ${action.id} is invalid.`,
        refs,
      );
    }
    const job: ClawCronJob = {
      id: details.id,
      ...(details.name ? { name: details.name } : {}),
      schedule: details.schedule,
      session: details.session,
      message: details.message,
      ...(details.delivery ? { delivery: details.delivery } : {}),
    };
    const pending = persistPendingRef(plan, job, options);
    refs.push(pending);
    let result: { id: string } | undefined;
    if (pending.status === "complete" && pending.schedulerJobId) {
      if (!options.gateway.list) {
        continue;
      }
      if (!agentAvailable) {
        await options.gateway.waitUntilAgentAvailable?.(plan.agent.finalId);
        agentAvailable = true;
      }
      const listedJob = schedulerJobRecordByDeclarationKey(
        await options.gateway.list(plan.agent.finalId),
        pending.declarationKey,
      );
      if (listedJob) {
        if (!clawCronGatewayJobMatchesRef(plan.agent.finalId, pending, listedJob)) {
          throw new ClawCronInstallError(
            "cron_reconcile_conflict",
            `Cron declaration ${JSON.stringify(pending.manifestId)} changed after installation.`,
            refs,
          );
        }
        result = { id: listedJob.id as string };
        if (result.id !== pending.schedulerJobId) {
          refs[refs.length - 1] = updateRef(
            pending,
            { status: "complete", schedulerJobId: result.id },
            options,
          );
        }
        continue;
      }
      throw new ClawCronInstallError(
        "cron_reconcile_conflict",
        `Cron declaration ${JSON.stringify(pending.manifestId)} is missing; remove and add the Claw again to recreate it safely.`,
        refs,
      );
    }
    try {
      if (!agentAvailable) {
        await options.gateway.waitUntilAgentAvailable?.(plan.agent.finalId);
        agentAvailable = true;
      }
      if (options.gateway.list) {
        result = schedulerJobByDeclarationKey(
          await options.gateway.list(plan.agent.finalId),
          pending.declarationKey,
        );
      }
      result ??= clawCronSchedulerJobFromResult(
        await options.gateway.add(clawCronGatewayInput(plan.agent.finalId, pending)),
      );
      if (!result) {
        throw new Error("cron.add returned no scheduler job id");
      }
    } catch (error) {
      const message = coerceErrorMessage(error);
      refs[refs.length - 1] = updateRef(pending, { status: "pending", error: message }, options);
      throw new ClawCronInstallError("cron_install_failed", message, refs);
    }
    try {
      refs[refs.length - 1] = updateRef(
        pending,
        { status: "complete", schedulerJobId: result.id },
        options,
      );
    } catch (error) {
      const message = coerceErrorMessage(error);
      throw new ClawCronInstallError(
        "cron_provenance_failed",
        `cron.add succeeded, but its scheduler id could not be persisted: ${message}`,
        refs,
      );
    }
  }
  return refs;
}

export function readClawCronRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawCronRef[] {
  const database = openOpenClawStateDatabase(options);
  if (
    options.readOnly &&
    !database.db /* sqlite-allow-raw: read-only Claw cron table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_cron_refs'")
      .get()
  ) {
    return [];
  }
  const query = getNodeSqliteKysely<CronRefDatabase>(database.db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .where("agent_id", "=", agentId)
    .orderBy("manifest_id")
    .compile();
  const rows =
    database.db /* sqlite-allow-raw: execute compiled Kysely with the existing native read error boundary. */
      .prepare(query.sql)
      // SAFETY: The compiled predicate binds a string; the canonical schema supplies the row shape.
      .all(...(query.parameters as SQLInputValue[])) as CronRefRow[];
  return rows.map(rowToRef);
}

export function deleteClawCronRef(
  agentId: string,
  manifestId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .deleteFrom("claw_cron_refs")
        .where("agent_id", "=", agentId)
        .where("manifest_id", "=", manifestId),
    );
  }, options);
}

export function markClawCronRefRemoved(
  agentId: string,
  manifestId: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawCronRef | undefined {
  const ref = readClawCronRefs(agentId, options).find(
    (candidate) => candidate.manifestId === manifestId,
  );
  return ref ? updateRef(ref, { status: "removed" }, options) : undefined;
}

export function upsertClawCronRef(
  ref: PersistedClawCronRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .insertInto("claw_cron_refs")
        .values(refToRow(ref))
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "manifest_id"]).doUpdateSet((eb) => ({
            schema_version: eb.ref("excluded.schema_version"),
            declaration_key: eb.ref("excluded.declaration_key"),
            scheduler_job_id: eb.ref("excluded.scheduler_job_id"),
            status: eb.ref("excluded.status"),
            job_json: eb.ref("excluded.job_json"),
            error: eb.ref("excluded.error"),
            updated_at_ms: eb.ref("excluded.updated_at_ms"),
          })),
        ),
    );
  }, options);
}
