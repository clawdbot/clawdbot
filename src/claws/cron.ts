import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import type { CronJob } from "../cron/types.js";
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

type CronRefRow = {
  schema_version: string;
  agent_id: string;
  manifest_id: string;
  declaration_key: string;
  scheduler_job_id: string | null;
  status: PersistedClawCronRef["status"];
  job_json: string;
  error: string | null;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

export type ClawCronGateway = {
  add: (input: Record<string, unknown>) => Promise<unknown>;
  get?: (schedulerJobId: string) => Promise<unknown>;
  list?: (agentId: string) => Promise<unknown>;
  remove: (schedulerJobId: string) => Promise<unknown>;
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
    status: row.status,
    job: JSON.parse(row.job_json) as ClawCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
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
  const existing =
    database.db /* sqlite-allow-raw: read one Claw cron ownership row by closed agent and manifest ids. */
      .prepare(
        `SELECT schema_version, agent_id, manifest_id, declaration_key, scheduler_job_id,
              status, job_json, error, created_at_ms, updated_at_ms
         FROM claw_cron_refs
        WHERE agent_id = ? AND manifest_id = ?`,
      )
      .get(plan.agent.finalId, job.id) as CronRefRow | undefined;
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
    db /* sqlite-allow-raw: insert one pending Claw cron ownership row. */
      .prepare(
        `INSERT INTO claw_cron_refs (
         agent_id, manifest_id, schema_version, declaration_key, scheduler_job_id,
         status, job_json, error, created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @manifest_id, @schema_version, @declaration_key, NULL,
         @status, @job_json, NULL, @created_at_ms, @updated_at_ms
       )`,
      )
      .run({
        agent_id: record.agentId,
        manifest_id: record.manifestId,
        schema_version: record.schemaVersion,
        declaration_key: record.declarationKey,
        status: record.status,
        job_json: JSON.stringify(record.job),
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      });
  }, options);
  return record;
}

function updateRef(
  ref: PersistedClawCronRef,
  update: { schedulerJobId?: string; status: PersistedClawCronRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  const updated = {
    ...ref,
    ...update,
    updatedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: update one Claw cron ownership row. */
      .prepare(
        `UPDATE claw_cron_refs
          SET scheduler_job_id = @scheduler_job_id,
              status = @status,
              error = @error,
              updated_at_ms = @updated_at_ms
        WHERE agent_id = @agent_id AND manifest_id = @manifest_id`,
      )
      .run({
        agent_id: ref.agentId,
        manifest_id: ref.manifestId,
        scheduler_job_id: update.schedulerJobId ?? null,
        status: update.status,
        error: update.error ?? null,
        updated_at_ms: updated.updatedAtMs,
      });
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

function schedulerJobByDeclarationKey(
  value: unknown,
  declarationKey: string,
): { id: string } | undefined {
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
  const live = value as Partial<CronJob>;
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
  try {
    return (
      resolveCronJobConfigRevision({
        ...expected,
        id: live.id,
        createdAtMs: live.createdAtMs,
        updatedAtMs: live.updatedAtMs,
        state: live.state,
      }) === resolveCronJobConfigRevision(live as CronJob)
    );
  } catch {
    return false;
  }
}

export async function installClawCronJobs(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    gateway?: Pick<ClawCronGateway, "add" | "list">;
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
      "Claw cron jobs require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedClawCronRef[] = [];
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
    if (pending.status === "complete" && pending.schedulerJobId) {
      continue;
    }
    let result: { id: string } | undefined;
    try {
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
      const message = error instanceof Error ? error.message : String(error);
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
      const message = error instanceof Error ? error.message : String(error);
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
  const rows = database.db /* sqlite-allow-raw: read Claw cron ownership rows by closed agent id. */
    .prepare(
      `SELECT schema_version, agent_id, manifest_id, declaration_key, scheduler_job_id,
              status, job_json, error, created_at_ms, updated_at_ms
         FROM claw_cron_refs
        WHERE agent_id = ?
        ORDER BY manifest_id`,
    )
    .all(agentId) as CronRefRow[];
  return rows.map(rowToRef);
}

export function deleteClawCronRef(
  agentId: string,
  manifestId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: delete one Claw cron ownership row after scheduler cleanup. */
      .prepare("DELETE FROM claw_cron_refs WHERE agent_id = ? AND manifest_id = ?")
      .run(agentId, manifestId);
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
    db /* sqlite-allow-raw: Claw cron lifecycle provenance write. */
      .prepare(
        `INSERT INTO claw_cron_refs (
         agent_id, manifest_id, schema_version, declaration_key, scheduler_job_id,
         status, job_json, error, created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @manifest_id, @schema_version, @declaration_key, @scheduler_job_id,
         @status, @job_json, @error, @created_at_ms, @updated_at_ms
       )
       ON CONFLICT(agent_id, manifest_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         declaration_key = excluded.declaration_key,
         scheduler_job_id = excluded.scheduler_job_id,
         status = excluded.status,
         job_json = excluded.job_json,
         error = excluded.error,
         updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        agent_id: ref.agentId,
        manifest_id: ref.manifestId,
        schema_version: ref.schemaVersion,
        declaration_key: ref.declarationKey,
        scheduler_job_id: ref.schedulerJobId ?? null,
        status: ref.status,
        job_json: JSON.stringify(ref.job),
        error: ref.error ?? null,
        created_at_ms: ref.createdAtMs,
        updated_at_ms: ref.updatedAtMs,
      });
  }, options);
}
