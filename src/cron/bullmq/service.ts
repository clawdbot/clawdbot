/**
 * BullMQ-backed CronService
 *
 * Replaces the setTimeout-based implementation with Redis-backed job schedulers.
 * Maintains backward compatibility with the existing CronService interface.
 */

import { CronQueue } from "./queue.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "../types.js";
import type { CronEvent, CronServiceDeps } from "../service/state.js";
import {
  applyJobPatch,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
} from "../service/jobs.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import { locked } from "../service/locked.js";
import { ensureLoaded, persist, warnIfDisabled } from "../service/store.js";

import type { CronQueueConfig } from "./queue.js";

import { readCronRunLogEntries, resolveCronRunLogPath, type CronRunLogEntry } from "../run-log.js";

export type BullMQCronServiceDeps = CronServiceDeps & {
  redisUrl?: string;
  queueConfig?: CronQueueConfig;
};

export type BullMQCronServiceState = {
  deps: BullMQCronServiceDeps & { nowMs: () => number };
  store: CronStoreFile | null;
  queue: CronQueue | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
};

function createState(deps: BullMQCronServiceDeps): BullMQCronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    queue: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
  };
}

function emit(state: BullMQCronServiceState, evt: CronEvent) {
  try {
    state.deps.onEvent?.(evt);
  } catch {
    /* ignore */
  }
}

export class BullMQCronService {
  private readonly state: BullMQCronServiceState;

  constructor(deps: BullMQCronServiceDeps) {
    this.state = createState(deps);
  }

  async start() {
    if (!this.state.deps.cronEnabled) {
      this.state.deps.log.info({ enabled: false }, "cron: disabled");
      return;
    }

    // Create and start the BullMQ queue
    this.state.queue = new CronQueue({
      redisUrl: this.state.deps.redisUrl,
      log: this.state.deps.log,
      config: this.state.deps.queueConfig,
      onJobDue: async (cronJobId: string) => {
        return await this.executeJob(cronJobId);
      },
    });

    await this.state.queue.start();

    // Load store and sync to BullMQ (copy jobs array to avoid race condition)
    const jobsCopy = await locked(this.state, async () => {
      await ensureLoaded(this.state);
      return [...(this.state.store?.jobs ?? [])];
    });

    if (this.state.queue) {
      await this.state.queue.syncFromStore(jobsCopy);
    }

    const status = await this.state.queue.getStatus();
    this.state.deps.log.info(
      {
        enabled: true,
        jobs: this.state.store?.jobs.length ?? 0,
        schedulers: status.schedulers,
        waiting: status.waiting,
        active: status.active,
      },
      "cron: bullmq service started",
    );
  }

  async stop() {
    // Graceful shutdown
    if (this.state.queue) {
      await this.state.queue.stop();
      this.state.queue = null;
    }
  }

  async status() {
    const queueStatus = this.state.queue ? await this.state.queue.getStatus() : null;
    return {
      enabled: this.state.deps.cronEnabled,
      storePath: this.state.deps.storePath,
      jobs: this.state.store?.jobs.length ?? 0,
      nextWakeAtMs: null, // BullMQ handles scheduling
      bullmq: queueStatus,
    };
  }

  async list(opts?: { includeDisabled?: boolean }) {
    return await locked(this.state, async () => {
      await ensureLoaded(this.state);
      const includeDisabled = opts?.includeDisabled === true;
      const jobs = (this.state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
      return jobs.sort((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
    });
  }

  async add(input: CronJobCreate) {
    return await locked(this.state, async () => {
      warnIfDisabled(this.state, "add");
      await ensureLoaded(this.state);

      const job = createJob(this.state, input);
      this.state.store?.jobs.push(job);
      await persist(this.state);

      // Sync to BullMQ
      if (this.state.queue && job.enabled) {
        await this.state.queue.upsertJobScheduler(job);
      }

      emit(this.state, {
        jobId: job.id,
        action: "added",
        nextRunAtMs: job.state.nextRunAtMs,
      });

      return job;
    });
  }

  async update(id: string, patch: CronJobPatch) {
    return await locked(this.state, async () => {
      warnIfDisabled(this.state, "update");
      await ensureLoaded(this.state);

      const job = findJobOrThrow(this.state, id);
      const now = this.state.deps.nowMs();
      applyJobPatch(job, patch);
      job.updatedAtMs = now;

      if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
      } else {
        job.state.nextRunAtMs = undefined;
        job.state.runningAtMs = undefined;
      }

      await persist(this.state);

      // Sync to BullMQ
      if (this.state.queue) {
        if (job.enabled) {
          await this.state.queue.upsertJobScheduler(job);
        } else {
          await this.state.queue.removeJobScheduler(id);
        }
      }

      emit(this.state, {
        jobId: id,
        action: "updated",
        nextRunAtMs: job.state.nextRunAtMs,
      });

      return job;
    });
  }

  async remove(id: string) {
    return await locked(this.state, async () => {
      warnIfDisabled(this.state, "remove");
      await ensureLoaded(this.state);

      const before = this.state.store?.jobs.length ?? 0;
      if (!this.state.store) return { ok: false, removed: false } as const;

      this.state.store.jobs = this.state.store.jobs.filter((j) => j.id !== id);
      const removed = (this.state.store.jobs.length ?? 0) !== before;

      await persist(this.state);

      // Remove from BullMQ
      if (this.state.queue && removed) {
        await this.state.queue.removeJobScheduler(id);
      }

      if (removed) emit(this.state, { jobId: id, action: "removed" });
      return { ok: true, removed } as const;
    });
  }

  async run(id: string, mode?: "due" | "force") {
    return await locked(this.state, async () => {
      warnIfDisabled(this.state, "run");
      await ensureLoaded(this.state);

      const job = findJobOrThrow(this.state, id);

      if (mode !== "force" && !job.enabled) {
        return { ok: true, ran: false, reason: "not-due" as const };
      }

      // Trigger immediate execution via BullMQ
      if (this.state.queue) {
        await this.state.queue.runNow(id);
      }

      return { ok: true, ran: true } as const;
    });
  }

  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    const text = opts.text.trim();
    if (!text) return { ok: false } as const;
    this.state.deps.enqueueSystemEvent(text);
    if (opts.mode === "now") {
      this.state.deps.requestHeartbeatNow({ reason: "wake" });
    }
    return { ok: true } as const;
  }

  async getJobRuns(jobId: string, limit: number): Promise<CronRunLogEntry[]> {
    const bullmqRuns = this.state.queue
      ? ((await this.state.queue.getJobRuns(jobId, limit)) as CronRunLogEntry[])
      : [];

    if (bullmqRuns.length >= limit) {
      return bullmqRuns;
    }

    // Supplement with file-based logs for older history
    const logPath = resolveCronRunLogPath({
      storePath: this.state.deps.storePath,
      jobId,
    });
    const fileRuns = await readCronRunLogEntries(logPath, {
      limit: limit - bullmqRuns.length,
      jobId,
    });

    // Merge and sort descending by timestamp
    const seenTs = new Set(bullmqRuns.map((r) => r.ts));
    const merged = [...bullmqRuns];
    for (const run of fileRuns) {
      if (!seenTs.has(run.ts)) {
        merged.push(run);
      }
    }

    return merged.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /**
   * Execute a cron job by ID (called by BullMQ worker)
   * Lock is held only for state reads/writes, not during job execution.
   */
  private async executeJob(cronJobId: string) {
    // Phase 1: Read job and mark as running (locked)
    const jobSnapshot = await locked(this.state, async () => {
      await ensureLoaded(this.state);

      const job = this.state.store?.jobs.find((j) => j.id === cronJobId);
      if (!job) {
        this.state.deps.log.warn({ cronJobId }, "cron: job not found for execution");
        return null;
      }

      const startedAt = this.state.deps.nowMs();
      job.state.runningAtMs = startedAt;
      job.state.lastError = undefined;
      await persist(this.state);

      emit(this.state, { jobId: job.id, action: "started", runAtMs: startedAt });

      // Return a copy of the job data needed for execution
      return {
        id: job.id,
        agentId: job.agentId,
        sessionTarget: job.sessionTarget,
        payload: job.payload,
        wakeMode: job.wakeMode,
        schedule: job.schedule,
        isolation: job.isolation,
        deleteAfterRun: job.deleteAfterRun,
        startedAt,
      };
    });

    if (!jobSnapshot) return;

    // Phase 2: Execute job (unlocked - can take minutes)
    let execResult: {
      status: "ok" | "error" | "skipped";
      error?: string;
      summary?: string;
      outputText?: string;
    };

    try {
      execResult = await this.runJobPayload(jobSnapshot);
    } catch (err) {
      execResult = { status: "error", error: String(err) };
    }

    // Phase 3: Update final state (locked)
    return await locked(this.state, async () => {
      await ensureLoaded(this.state);

      const job = this.state.store?.jobs.find((j) => j.id === cronJobId);
      if (!job) {
        this.state.deps.log.warn({ cronJobId }, "cron: job disappeared during execution");
        throw new Error(`Job ${cronJobId} not found after execution`);
      }

      const endedAt = this.state.deps.nowMs();
      const startedAt = jobSnapshot.startedAt;

      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = startedAt;
      job.state.lastStatus = execResult.status;
      job.state.lastDurationMs = Math.max(0, endedAt - startedAt);
      job.state.lastError = execResult.error;
      job.updatedAtMs = endedAt;

      const shouldDelete =
        job.schedule.kind === "at" && execResult.status === "ok" && job.deleteAfterRun === true;

      if (!shouldDelete) {
        if (job.schedule.kind === "at" && execResult.status === "ok") {
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
          if (this.state.queue) {
            await this.state.queue.removeJobScheduler(job.id);
          }
        } else if (job.enabled) {
          job.state.nextRunAtMs = computeJobNextRunAtMs(job, endedAt);
        } else {
          job.state.nextRunAtMs = undefined;
        }
      }

      emit(this.state, {
        jobId: job.id,
        action: "finished",
        status: execResult.status,
        error: execResult.error,
        summary: execResult.summary,
        outputText: execResult.outputText,
        runAtMs: startedAt,
        durationMs: job.state.lastDurationMs,
        nextRunAtMs: job.state.nextRunAtMs,
      });

      if (shouldDelete && this.state.store) {
        this.state.store.jobs = this.state.store.jobs.filter((j) => j.id !== job.id);
        if (this.state.queue) {
          await this.state.queue.removeJobScheduler(job.id);
        }
        emit(this.state, { jobId: job.id, action: "removed" });
      }

      // Post to main session for isolated jobs
      if (job.sessionTarget === "isolated") {
        const prefix = job.isolation?.postToMainPrefix?.trim() || "Cron";
        const mode = job.isolation?.postToMainMode ?? "summary";

        let body = (execResult.summary ?? execResult.error ?? execResult.status).trim();
        if (mode === "full") {
          const maxCharsRaw = job.isolation?.postToMainMaxChars;
          const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(0, maxCharsRaw as number) : 8000;
          const fullText = (execResult.outputText ?? "").trim();
          if (fullText) {
            body = fullText.length > maxChars ? `${fullText.slice(0, maxChars)}…` : fullText;
          }
        }

        const statusPrefix =
          execResult.status === "ok" ? prefix : `${prefix} (${execResult.status})`;
        this.state.deps.enqueueSystemEvent(`${statusPrefix}: ${body}`, {
          agentId: job.agentId,
        });
        if (job.wakeMode === "now") {
          this.state.deps.requestHeartbeatNow({ reason: `cron:${job.id}:post` });
        }
      }

      await persist(this.state);

      return {
        ts: endedAt,
        jobId: job.id,
        action: "finished",
        status: execResult.status,
        error: execResult.error ?? undefined,
        summary: execResult.summary ?? "",
        outputText: execResult.outputText ?? "",
        runAtMs: startedAt,
        durationMs: job.state.lastDurationMs,
        nextRunAtMs: job.state.nextRunAtMs,
      };
    });
  }

  /**
   * Run the actual job payload (without holding lock)
   */
  private async runJobPayload(job: {
    id: string;
    agentId?: string;
    sessionTarget: string;
    payload: CronJob["payload"];
    wakeMode: string;
    schedule: CronJob["schedule"];
  }): Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    summary?: string;
    outputText?: string;
  }> {
    if (job.sessionTarget === "main") {
      if (job.payload.kind !== "systemEvent") {
        return { status: "skipped", error: 'main job requires payload.kind="systemEvent"' };
      }
      const text = job.payload.text?.trim();
      if (!text) {
        return { status: "skipped", error: "main job requires non-empty systemEvent text" };
      }

      this.state.deps.enqueueSystemEvent(text, { agentId: job.agentId });

      if (job.wakeMode === "now" && this.state.deps.runHeartbeatOnce) {
        const reason = `cron:${job.id}`;
        const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        const maxWaitMs = 2 * 60_000;
        const waitStartedAt = this.state.deps.nowMs();

        let heartbeatResult: HeartbeatRunResult;
        for (;;) {
          heartbeatResult = await this.state.deps.runHeartbeatOnce({ reason });
          if (
            heartbeatResult.status !== "skipped" ||
            heartbeatResult.reason !== "requests-in-flight"
          ) {
            break;
          }
          if (this.state.deps.nowMs() - waitStartedAt > maxWaitMs) {
            heartbeatResult = {
              status: "skipped",
              reason: "timeout waiting for main lane to become idle",
            };
            break;
          }
          await delay(250);
        }

        if (heartbeatResult.status === "ran") {
          return { status: "ok", summary: text };
        } else if (heartbeatResult.status === "skipped") {
          return { status: "skipped", error: heartbeatResult.reason, summary: text };
        } else {
          return { status: "error", error: heartbeatResult.reason, summary: text };
        }
      } else {
        this.state.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
        return { status: "ok", summary: text };
      }
    }

    // Isolated job
    if (job.payload.kind !== "agentTurn") {
      return { status: "skipped", error: "isolated job requires payload.kind=agentTurn" };
    }

    // Need the full job object for runIsolatedAgentJob
    const fullJob = await locked(this.state, async () => {
      await ensureLoaded(this.state);
      return this.state.store?.jobs.find((j) => j.id === job.id);
    });

    if (!fullJob) {
      return { status: "error", error: "job not found" };
    }

    const res = await this.state.deps.runIsolatedAgentJob({
      job: fullJob,
      message: job.payload.message,
    });

    return {
      status: res.status,
      error: res.error,
      summary: res.summary,
      outputText: res.outputText,
    };
  }
}
