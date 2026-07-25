/** Doctor-owned migration from heartbeat scratch `tasks:` blocks into cron jobs. */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { heartbeatTaskDeclarationKey, isHeartbeatTaskCronJob } from "../cron/heartbeat-task.js";
import { cronSchedulingInputsEqual } from "../cron/schedule-identity.js";
import { readHeartbeatMonitorScratch } from "../cron/scratch-store.js";
import { computeJobNextRunAtMs, hasScheduledNextRunAtMs } from "../cron/service/jobs.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  assertCronStoreCanPersist,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import type { CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveHeartbeatAgents, resolveHeartbeatSession } from "../infra/heartbeat-runner.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { shortenHomePath } from "../utils.js";
import { analyzeLegacyHeartbeatTasks, type LegacyHeartbeatTask } from "./heartbeat-task-legacy.js";

const HEARTBEAT_TASK_MIGRATION_CHECK_ID = "core/doctor/heartbeat-task-cron-migration";

type HeartbeatTaskMigrationResult = { changes: string[]; warnings: string[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ValidatedHeartbeatTask = {
  task: LegacyHeartbeatTask;
  intervalMs: number;
  occurrenceIndex: number;
};

function validateTasks(
  tasks: readonly LegacyHeartbeatTask[],
  declaredEntryCount: number,
): ValidatedHeartbeatTask[] {
  if (tasks.length === 0) {
    throw new Error("tasks: block has no complete name/interval/prompt entries");
  }
  if (tasks.length !== declaredEntryCount) {
    throw new Error("tasks: block contains an incomplete name/interval/prompt entry");
  }
  const occurrenceCounts = new Map<string, number>();
  const validated: ValidatedHeartbeatTask[] = [];
  for (const task of tasks) {
    const intervalMs = parseDurationMs(task.interval, { defaultUnit: "m" });
    if (intervalMs <= 0) {
      throw new Error(`task ${JSON.stringify(task.name)} interval must be greater than zero`);
    }
    const occurrenceIndex = occurrenceCounts.get(task.name) ?? 0;
    occurrenceCounts.set(task.name, occurrenceIndex + 1);
    validated.push({ task, intervalMs, occurrenceIndex });
  }
  return validated;
}

function migrationFinding(params: {
  storePath: string;
  agentId: string;
  message: string;
  severity?: HealthFinding["severity"];
  requirement: string;
}): HealthFinding {
  return {
    checkId: HEARTBEAT_TASK_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.storePath,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to convert heartbeat tasks into cron jobs.`,
  };
}

/** Reports task blocks still owned by heartbeat scratch without changing them. */
export async function collectHeartbeatTaskMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const findings: HealthFinding[] = [];
  for (const agent of resolveHeartbeatAgents(cfg)) {
    let monitor: ReturnType<typeof readHeartbeatMonitorScratch>;
    try {
      monitor = readHeartbeatMonitorScratch(storePath, agent.agentId, { env });
    } catch (error) {
      findings.push(
        migrationFinding({
          storePath,
          agentId: agent.agentId,
          requirement: "heartbeat-task-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" heartbeat scratch cannot be inspected: ${errorMessage(error)}`,
        }),
      );
      continue;
    }
    const content = monitor?.state.scratch?.content;
    if (!content) {
      continue;
    }
    const document = analyzeLegacyHeartbeatTasks(content);
    if (!document.hasTasksBlock) {
      continue;
    }
    try {
      validateTasks(document.tasks, document.taskEntryCount);
      findings.push(
        migrationFinding({
          storePath,
          agentId: agent.agentId,
          requirement: "heartbeat-tasks-in-scratch",
          message: `Agent "${agent.agentId}" has ${document.tasks.length} heartbeat task${document.tasks.length === 1 ? "" : "s"} that must become cron jobs.`,
        }),
      );
    } catch (error) {
      findings.push(
        migrationFinding({
          storePath,
          agentId: agent.agentId,
          requirement: "heartbeat-task-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" heartbeat tasks cannot be migrated: ${errorMessage(error)}`,
        }),
      );
    }
  }
  return findings;
}

function taskJobInput(params: {
  agentId: string;
  task: LegacyHeartbeatTask;
  occurrenceIndex: number;
  intervalMs: number;
  lastRunAtMs?: number;
  existing?: CronJob;
  nowMs: number;
}) {
  const existingAnchor =
    params.existing?.schedule.kind === "every" &&
    params.existing.schedule.everyMs === params.intervalMs
      ? params.existing.schedule.anchorMs
      : undefined;
  const nextDueMs =
    params.lastRunAtMs === undefined || params.lastRunAtMs + params.intervalMs <= params.nowMs
      ? params.nowMs + 1
      : params.lastRunAtMs + params.intervalMs;
  return {
    declarationKey: heartbeatTaskDeclarationKey(
      params.agentId,
      params.task.name,
      params.occurrenceIndex,
    ),
    displayName: truncateUtf16Safe(`Heartbeat task: ${params.task.name}`, 200),
    name: params.task.name,
    description: "Migrated from heartbeat monitor scratch by openclaw doctor.",
    agentId: params.agentId,
    enabled: true,
    schedule: {
      kind: "every" as const,
      everyMs: params.intervalMs,
      anchorMs: existingAnchor ?? nextDueMs,
    },
    payload: { kind: "systemEvent" as const, text: params.task.prompt },
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    ...(params.lastRunAtMs === undefined ? {} : { state: { lastRunAtMs: params.lastRunAtMs } }),
  };
}

type TaskJobPlan = {
  declarationKey: string;
  previous?: CronJob;
  job: CronJob;
  sortOrder: number;
};

type AgentTaskMigrationPlan = {
  monitorJobId: string;
  scratchRevision: number;
  strippedContent: string;
  jobs: TaskJobPlan[];
};

type CronPlanningSnapshot = {
  jobs: CronJob[];
  sortOrderByJobId: Map<string, number>;
  nextSortOrder: number;
};

type MigrationCommitResult =
  | { ok: true; currentRevision: number }
  | { ok: false; reason: "job-conflict" | "revision-conflict" };

function taskDeclarativeFields(job: CronJob) {
  return {
    schedule: job.schedule,
    pacing: job.pacing,
    trigger: job.trigger,
    payload: job.payload,
    delivery: job.delivery,
    displayName: job.displayName,
    enabled: job.enabled,
  };
}

function convergeTaskJob(params: {
  agentId: string;
  task: LegacyHeartbeatTask;
  occurrenceIndex: number;
  intervalMs: number;
  lastRunAtMs?: number;
  existing?: CronJob;
  nowMs: number;
}): CronJob {
  const input = taskJobInput(params);
  if (!params.existing) {
    const { state, ...fields } = input;
    const job: CronJob = {
      id: randomUUID(),
      ...fields,
      createdAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
      state: { ...state },
    };
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
    return job;
  }

  const previous = params.existing;
  const job = structuredClone(previous);
  job.displayName = input.displayName;
  job.schedule = structuredClone(input.schedule);
  job.payload = structuredClone(input.payload);
  job.enabled = true;
  delete job.pacing;
  delete job.trigger;
  delete job.delivery;
  if (isDeepStrictEqual(taskDeclarativeFields(previous), taskDeclarativeFields(job))) {
    return job;
  }

  job.updatedAtMs = params.nowMs;
  if (!cronSchedulingInputsEqual(previous, job)) {
    job.state.startupCatchupAtMs = undefined;
    job.state.pacedNextRunAtMs = undefined;
    job.state.forcePreservedNextRunAtMs = undefined;
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
  } else if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
  }
  return job;
}

async function loadCronPlanningSnapshot(
  storePath: string,
  env: NodeJS.ProcessEnv,
): Promise<CronPlanningSnapshot> {
  const rows = loadCronRows(openOpenClawStateDatabase({ env }).db, cronStoreKey(storePath));
  const sortOrderByJobId = new Map(rows.map((row) => [row.job_id, row.sort_order] as const));
  return {
    jobs: loadedCronStoreFromRows(rows).store.jobs,
    sortOrderByJobId,
    nextSortOrder: rows.reduce((max, row) => Math.max(max, row.sort_order + 1), 0),
  };
}

function reserveSortOrder(snapshot: CronPlanningSnapshot, existing?: CronJob): number {
  const persisted = existing ? snapshot.sortOrderByJobId.get(existing.id) : undefined;
  if (persisted !== undefined) {
    return persisted;
  }
  const sortOrder = snapshot.nextSortOrder;
  snapshot.nextSortOrder += 1;
  return sortOrder;
}

function readScratchRevision(db: DatabaseSync, storeKey: string, jobId: string): number {
  return (
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .selectFrom("cron_job_scratch")
        .select("revision")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId),
    ).rows[0]?.revision ?? 0
  );
}

function commitAgentTaskMigration(params: {
  storePath: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  plan: AgentTaskMigrationPlan;
}): MigrationCommitResult {
  const storeKey = cronStoreKey(params.storePath);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (
        readScratchRevision(db, storeKey, params.plan.monitorJobId) !== params.plan.scratchRevision
      ) {
        return { ok: false, reason: "revision-conflict" } as const;
      }

      const rows = loadCronRows(db, storeKey);
      const jobsById = new Map(
        loadedCronStoreFromRows(rows).store.jobs.map((job) => [job.id, job] as const),
      );
      for (const jobPlan of params.plan.jobs) {
        const matchingRows = rows.filter((row) => row.declaration_key === jobPlan.declarationKey);
        if (jobPlan.previous) {
          const current = jobsById.get(jobPlan.previous.id);
          if (
            matchingRows.length !== 1 ||
            !current ||
            !isDeepStrictEqual(current, jobPlan.previous)
          ) {
            return { ok: false, reason: "job-conflict" } as const;
          }
        } else if (matchingRows.length > 0 || rows.some((row) => row.job_id === jobPlan.job.id)) {
          return { ok: false, reason: "job-conflict" } as const;
        }
      }

      for (const jobPlan of params.plan.jobs) {
        if (!jobPlan.previous || !isDeepStrictEqual(jobPlan.previous, jobPlan.job)) {
          upsertCronJobRow(db, storeKey, jobPlan.job, jobPlan.sortOrder);
        }
      }

      const updated = executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .updateTable("cron_job_scratch")
          .set({
            content: params.plan.strippedContent,
            revision: params.plan.scratchRevision + 1,
            source_sha256: null,
            updated_at_ms: params.nowMs,
          })
          .where("store_key", "=", storeKey)
          .where("job_id", "=", params.plan.monitorJobId)
          .where("revision", "=", params.plan.scratchRevision),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("scratch revision changed inside task migration transaction");
      }
      // Like cadence materialization, doctor only commits durable rows. A live
      // gateway reloads the cron store through its normal reload path and arms
      // these persisted nextRunAtMs values; doctor never owns its timer.
      return { ok: true, currentRevision: params.plan.scratchRevision + 1 } as const;
    },
    { env: params.env },
    { operationLabel: "doctor.heartbeat-task-migration" },
  );
}

async function clearLegacyTaskTimestamps(params: {
  storePath: string;
  sessionKey: string;
  env: NodeJS.ProcessEnv;
  tasks: readonly LegacyHeartbeatTask[];
}): Promise<void> {
  await patchSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey, env: params.env },
    (entry) => {
      const remaining = { ...entry.heartbeatTaskState };
      let changed = false;
      for (const task of params.tasks) {
        if (Object.hasOwn(remaining, task.name)) {
          delete remaining[task.name];
          changed = true;
        }
      }
      if (!changed) {
        return null;
      }
      return {
        heartbeatTaskState: Object.keys(remaining).length > 0 ? remaining : undefined,
      };
    },
    { preserveActivity: true },
  );
}

/** Converts valid scratch tasks and removes their source block in one SQLite transaction. */
export async function maybeMigrateHeartbeatTasksToCron(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<HeartbeatTaskMigrationResult> {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  const candidates: Array<{
    agent: ReturnType<typeof resolveHeartbeatAgents>[number];
    document: ReturnType<typeof analyzeLegacyHeartbeatTasks>;
    monitor: NonNullable<ReturnType<typeof readHeartbeatMonitorScratch>>;
    scratchRevision: number;
    validatedTasks: ValidatedHeartbeatTask[];
  }> = [];
  for (const agent of resolveHeartbeatAgents(params.cfg)) {
    let monitor: ReturnType<typeof readHeartbeatMonitorScratch>;
    try {
      monitor = readHeartbeatMonitorScratch(storePath, agent.agentId, { env });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" heartbeat scratch could not be inspected: ${errorMessage(error)}.`,
      );
      continue;
    }
    const scratch = monitor?.state.scratch;
    if (!monitor || !scratch) {
      continue;
    }
    const document = analyzeLegacyHeartbeatTasks(scratch.content);
    if (!document.hasTasksBlock) {
      continue;
    }
    const tasks = document.tasks;
    let validatedTasks: ValidatedHeartbeatTask[];
    try {
      validatedTasks = validateTasks(tasks, document.taskEntryCount);
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" heartbeat tasks were not migrated: ${errorMessage(error)}.`,
      );
      continue;
    }
    if (!params.shouldRepair) {
      note(
        `${tasks.length} task${tasks.length === 1 ? "" : "s"} in ${shortenHomePath(storePath)} will become independently scheduled cron jobs for agent "${agent.agentId}".`,
        "Heartbeat task migration preview",
      );
      continue;
    }
    candidates.push({
      agent,
      document,
      monitor,
      scratchRevision: scratch.revision,
      validatedTasks,
    });
  }

  if (!params.shouldRepair || candidates.length === 0) {
    if (warnings.length > 0) {
      note(warnings.join("\n"), "Doctor warnings");
    }
    return { changes, warnings };
  }

  let snapshot: CronPlanningSnapshot;
  try {
    // The scratch revisions above are pinned before this async planning read.
    // Concurrent doctors can therefore plan R together and serialize at commit.
    snapshot = await loadCronPlanningSnapshot(storePath, env);
  } catch (error) {
    const warning = `Could not inspect cron jobs for heartbeat task migration: ${errorMessage(error)}`;
    note(warning, "Doctor warnings");
    return { changes, warnings: [...warnings, warning] };
  }

  for (const candidate of candidates) {
    const { agent, document, monitor, scratchRevision, validatedTasks } = candidate;
    const session = resolveHeartbeatSession(
      params.cfg,
      agent.agentId,
      agent.heartbeat,
      undefined,
      env,
    );
    const legacyState = session.entry?.heartbeatTaskState ?? {};
    const jobPlans: TaskJobPlan[] = [];
    let blocked = false;
    for (const { task, intervalMs, occurrenceIndex } of validatedTasks) {
      const declarationKey = heartbeatTaskDeclarationKey(agent.agentId, task.name, occurrenceIndex);
      const matches = snapshot.jobs.filter((job) => job.declarationKey === declarationKey);
      const existing = matches[0];
      if (
        matches.length > 1 ||
        (existing &&
          (!isHeartbeatTaskCronJob(existing) ||
            existing.agentId !== agent.agentId ||
            existing.name !== task.name))
      ) {
        warnings.push(
          `Agent "${agent.agentId}" task ${JSON.stringify(task.name)} collides with an incompatible cron declaration; scratch was left unchanged.`,
        );
        blocked = true;
        break;
      }
      const legacyLastRun = legacyState[task.name];
      const lastRunAtMs =
        typeof legacyLastRun === "number" && Number.isFinite(legacyLastRun)
          ? legacyLastRun
          : undefined;
      const job = convergeTaskJob({
        agentId: agent.agentId,
        task,
        occurrenceIndex,
        intervalMs,
        lastRunAtMs,
        existing,
        nowMs,
      });
      const sortOrder = reserveSortOrder(snapshot, existing);
      jobPlans.push({
        declarationKey,
        ...(existing ? { previous: structuredClone(existing) } : {}),
        job,
        sortOrder,
      });
    }
    if (blocked) {
      continue;
    }

    try {
      assertCronStoreCanPersist({ version: 1, jobs: jobPlans.map((plan) => plan.job) });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task jobs could not be planned: ${errorMessage(error)}. Scratch was left unchanged.`,
      );
      continue;
    }

    const plan: AgentTaskMigrationPlan = {
      monitorJobId: monitor.jobId,
      scratchRevision,
      strippedContent: document.strippedContent,
      jobs: jobPlans,
    };
    let committed: MigrationCommitResult;
    try {
      committed = commitAgentTaskMigration({ storePath, env, nowMs, plan });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task migration could not be committed: ${errorMessage(error)}. Scratch and cron jobs were left unchanged.`,
      );
      continue;
    }
    if (!committed.ok) {
      warnings.push(
        committed.reason === "revision-conflict"
          ? `Agent "${agent.agentId}" scratch changed during task migration; no changes were committed.`
          : `Agent "${agent.agentId}" cron jobs changed during task migration; no changes were committed.`,
      );
      continue;
    }

    for (const jobPlan of jobPlans) {
      const index = snapshot.jobs.findIndex((job) => job.id === jobPlan.job.id);
      if (index >= 0) {
        snapshot.jobs[index] = jobPlan.job;
      } else {
        snapshot.jobs.push(jobPlan.job);
      }
      snapshot.sortOrderByJobId.set(jobPlan.job.id, jobPlan.sortOrder);
    }
    changes.push(
      `Converted ${document.tasks.length} heartbeat task${document.tasks.length === 1 ? "" : "s"} into cron jobs for agent "${agent.agentId}".`,
    );

    try {
      // Session task timestamps live in the per-agent database, so they cannot
      // join the state-DB commit. They are advisory once cron owns scheduling;
      // this idempotent cleanup may safely be retried or skipped after a crash.
      await clearLegacyTaskTimestamps({
        storePath: session.storePath,
        sessionKey: session.sessionKey,
        env,
        tasks: document.tasks,
      });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" legacy task timestamps could not be cleared after migration: ${errorMessage(error)}. Cron jobs remain authoritative and a rerun is safe.`,
      );
    }
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
