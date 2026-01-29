/**
 * BullMQ-based cron queue with job schedulers
 *
 * Key features:
 * - Redis-backed persistence (survives restarts)
 * - Job schedulers with upsert pattern for recurring jobs
 * - Built-in stall detection and retry
 * - Proper event logging
 */

import { Queue, Worker, type Job, QueueEvents } from "bullmq";
import type { CronJob, CronSchedule } from "../types.js";
import type { Logger } from "../service/state.js";

export const CRON_QUEUE_NAME = "moltbot-cron";

export type CronJobData = {
  cronJobId: string;
  scheduledAtMs: number;
};

export type CronQueueConfig = {
  /** Worker concurrency (default: 1) */
  workerConcurrency?: number;
  /** Job retry attempts on failure (default: 3) */
  jobRetryAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  jobRetryDelayMs?: number;
  /** Stalled job check interval in ms (default: 30000) */
  stalledIntervalMs?: number;
  /** Max stall count before job fails (default: 2) */
  maxStalledCount?: number;
  /** Completed jobs to retain (default: 100) */
  completedJobsRetention?: number;
  /** Failed jobs to retain (default: 500) */
  failedJobsRetention?: number;
};

export type CronQueueDeps = {
  redisUrl?: string;
  log: Logger;
  onJobDue: (cronJobId: string) => Promise<unknown>;
  config?: CronQueueConfig;
};

/**
 * Convert CronSchedule to BullMQ repeat pattern or delay
 */
export function scheduleToRepeatOpts(
  schedule: CronSchedule,
  nowMs: number,
): {
  repeat?: { pattern?: string; every?: number; tz?: string; startDate?: Date };
  delay?: number;
} | null {
  if (schedule.kind === "at") {
    // One-shot: use delay
    const delay = Math.max(0, schedule.atMs - nowMs);
    return { delay };
  }

  if (schedule.kind === "every") {
    // Interval: use repeat.every with optional startDate for anchoring
    const repeat: { every: number; startDate?: Date } = {
      every: schedule.everyMs,
    };
    if (typeof schedule.anchorMs === "number") {
      repeat.startDate = new Date(schedule.anchorMs);
    }
    return { repeat };
  }

  if (schedule.kind === "cron") {
    // Cron expression: use repeat.pattern
    return {
      repeat: {
        pattern: schedule.expr,
        tz: schedule.tz,
      },
    };
  }

  return null;
}

/**
 * Generate a deterministic job scheduler key for a cron job
 */
export function jobSchedulerKey(cronJobId: string): string {
  return `cron-${cronJobId}`;
}

export class CronQueue {
  private queue: Queue<CronJobData>;
  private worker: Worker<CronJobData> | null = null;
  private queueEvents: QueueEvents | null = null;
  private deps: CronQueueDeps;
  private config: Required<CronQueueConfig>;
  private connection: { host: string; port: number; password?: string; username?: string };
  private knownSchedulerIds = new Set<string>();

  constructor(deps: CronQueueDeps) {
    this.deps = deps;

    // Apply config with defaults
    this.config = {
      workerConcurrency: deps.config?.workerConcurrency ?? 3,
      jobRetryAttempts: deps.config?.jobRetryAttempts ?? 3,
      jobRetryDelayMs: deps.config?.jobRetryDelayMs ?? 1000,
      stalledIntervalMs: deps.config?.stalledIntervalMs ?? 30_000,
      maxStalledCount: deps.config?.maxStalledCount ?? 2,
      completedJobsRetention: deps.config?.completedJobsRetention ?? 100,
      failedJobsRetention: deps.config?.failedJobsRetention ?? 500,
    };

    // Parse Redis URL or use defaults
    const redisUrl = deps.redisUrl || process.env.REDIS_URL || "redis://localhost:6379";
    try {
      const url = new URL(redisUrl);
      this.connection = {
        host: url.hostname || "localhost",
        port: parseInt(url.port, 10) || 6379,
        password: url.password || undefined,
        username: url.username || undefined,
      };
    } catch (err) {
      throw new Error(`Invalid Redis URL: ${redisUrl} (${String(err)})`);
    }

    this.queue = new Queue<CronJobData>(CRON_QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: { count: this.config.completedJobsRetention },
        removeOnFail: { count: this.config.failedJobsRetention },
        attempts: this.config.jobRetryAttempts,
        backoff: {
          type: "exponential",
          delay: this.config.jobRetryDelayMs,
        },
      },
    });
  }

  async start() {
    // Wait for queue connection
    await this.queue.waitUntilReady();
    this.deps.log.debug({}, "cron: bullmq queue connected");

    // Start worker to process jobs
    this.worker = new Worker<CronJobData>(
      CRON_QUEUE_NAME,
      async (job: Job<CronJobData>) => {
        const { cronJobId } = job.data;
        this.deps.log.info({ cronJobId, jobId: job.id }, "cron: bullmq job processing");

        try {
          const result = await this.deps.onJobDue(cronJobId);
          this.deps.log.info({ cronJobId, jobId: job.id }, "cron: bullmq job completed");
          return result;
        } catch (err) {
          this.deps.log.error(
            { cronJobId, jobId: job.id, err: String(err) },
            "cron: bullmq job failed",
          );
          throw err; // Let BullMQ handle retry
        }
      },
      {
        connection: this.connection,
        concurrency: this.config.workerConcurrency,
        stalledInterval: this.config.stalledIntervalMs,
        maxStalledCount: this.config.maxStalledCount,
      },
    );

    // Wait for worker connection
    await this.worker.waitUntilReady();
    this.deps.log.debug({}, "cron: bullmq worker connected");

    // Set up event listeners for logging
    this.queueEvents = new QueueEvents(CRON_QUEUE_NAME, {
      connection: this.connection,
    });

    this.queueEvents.on("completed", ({ jobId }) => {
      this.deps.log.debug({ jobId }, "cron: bullmq event completed");
    });

    this.queueEvents.on("failed", ({ jobId, failedReason }) => {
      this.deps.log.warn({ jobId, failedReason }, "cron: bullmq event failed");
    });

    this.queueEvents.on("stalled", ({ jobId }) => {
      this.deps.log.warn({ jobId }, "cron: bullmq event stalled");
    });

    this.worker.on("error", (err) => {
      this.deps.log.error({ err: String(err) }, "cron: bullmq worker error");
    });

    // Worker-level stalled handler (provides job object)
    this.worker.on("stalled", (jobId: string) => {
      this.deps.log.warn({ jobId }, "cron: bullmq worker detected stalled job");
    });

    this.deps.log.info({}, "cron: bullmq queue started");
  }

  async stop() {
    // Graceful shutdown: close worker first (drains in-flight jobs)
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queueEvents) {
      await this.queueEvents.close();
      this.queueEvents = null;
    }
    await this.queue.close();
    this.deps.log.info({}, "cron: bullmq queue stopped");
  }

  /**
   * Check if the queue and worker are connected
   */
  async isReady(): Promise<boolean> {
    try {
      await this.queue.client;
      return this.worker !== null;
    } catch {
      return false;
    }
  }

  /**
   * Upsert a job scheduler for a recurring job.
   * For one-shot jobs (kind: "at"), adds a delayed job instead.
   */
  async upsertJobScheduler(job: CronJob): Promise<void> {
    const key = jobSchedulerKey(job.id);
    const nowMs = Date.now();
    const opts = scheduleToRepeatOpts(job.schedule, nowMs);

    if (!opts) {
      this.deps.log.warn({ cronJobId: job.id }, "cron: invalid schedule, skipping");
      return;
    }

    const jobData: CronJobData = {
      cronJobId: job.id,
      scheduledAtMs: nowMs,
    };

    if (job.schedule.kind === "at") {
      // One-shot job: remove existing first to allow rescheduling
      const existing = await this.queue.getJob(key);
      if (existing) {
        await existing.remove();
        this.deps.log.debug({ cronJobId: job.id }, "cron: removed existing one-shot job");
      }

      await this.queue.add(key, jobData, {
        delay: opts.delay,
        jobId: key,
      });
      this.deps.log.info({ cronJobId: job.id, delay: opts.delay }, "cron: scheduled one-shot job");
    } else {
      // Recurring job: upsert job scheduler
      await this.queue.upsertJobScheduler(key, opts.repeat!, {
        name: key,
        data: jobData,
      });
      this.knownSchedulerIds.add(job.id);
      this.deps.log.info(
        { cronJobId: job.id, repeat: opts.repeat },
        "cron: upserted job scheduler",
      );
    }
  }

  /**
   * Remove a job scheduler (or delayed job)
   */
  async removeJobScheduler(cronJobId: string): Promise<void> {
    const key = jobSchedulerKey(cronJobId);
    let removed = false;

    // Only try to remove scheduler if we know it exists
    if (this.knownSchedulerIds.has(cronJobId)) {
      try {
        await this.queue.removeJobScheduler(key);
        this.knownSchedulerIds.delete(cronJobId);
        removed = true;
        this.deps.log.info({ cronJobId }, "cron: removed job scheduler");
      } catch (err) {
        this.deps.log.debug({ cronJobId, err: String(err) }, "cron: no job scheduler to remove");
      }
    }

    // Also try to remove any pending delayed job
    const job = await this.queue.getJob(key);
    if (job) {
      await job.remove();
      removed = true;
      this.deps.log.info({ cronJobId }, "cron: removed delayed job");
    }

    if (!removed) {
      this.deps.log.debug({ cronJobId }, "cron: nothing to remove");
    }
  }

  /**
   * Sync all job schedulers from the cron store (parallelized)
   */
  async syncFromStore(jobs: CronJob[]): Promise<void> {
    const enabledJobs = jobs.filter((j) => j.enabled);
    const disabledJobIds = jobs.filter((j) => !j.enabled).map((j) => j.id);

    // Load existing schedulers to populate knownSchedulerIds
    try {
      const existingSchedulers = await this.queue.getJobSchedulers();
      for (const scheduler of existingSchedulers) {
        // Extract cronJobId from scheduler key (format: "cron-{cronJobId}")
        const match = scheduler.key?.match(/^cron-(.+)$/);
        if (match) {
          this.knownSchedulerIds.add(match[1]);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err: String(err) }, "cron: failed to load existing schedulers");
    }

    // Parallelize: remove disabled jobs and upsert enabled jobs concurrently
    const removePromises = disabledJobIds
      .filter((id) => this.knownSchedulerIds.has(id))
      .map((id) =>
        this.removeJobScheduler(id).catch((err) => {
          this.deps.log.warn({ cronJobId: id, err: String(err) }, "cron: sync remove failed");
        }),
      );

    const upsertPromises = enabledJobs.map((job) =>
      this.upsertJobScheduler(job).catch((err) => {
        this.deps.log.warn({ cronJobId: job.id, err: String(err) }, "cron: sync upsert failed");
      }),
    );

    await Promise.all([...removePromises, ...upsertPromises]);

    this.deps.log.info(
      { enabled: enabledJobs.length, disabled: disabledJobIds.length },
      "cron: synced job schedulers",
    );
  }

  /**
   * Get queue status
   */
  async getStatus() {
    const counts = await this.queue.getJobCounts();
    const schedulers = await this.queue.getJobSchedulers();
    const ready = await this.isReady();
    return {
      ready,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      paused: counts.paused ?? 0,
      schedulers: schedulers.length,
    };
  }

  /**
   * Force run a job immediately
   */
  async runNow(cronJobId: string): Promise<void> {
    const key = jobSchedulerKey(cronJobId);
    const jobData: CronJobData = {
      cronJobId,
      scheduledAtMs: Date.now(),
    };

    await this.queue.add(`${key}-manual`, jobData, {
      priority: 1, // High priority
    });
    this.deps.log.info({ cronJobId }, "cron: triggered manual run");
  }

  /**
   * Get run history for a job
   */
  async getJobRuns(cronJobId: string, limit: number): Promise<unknown[]> {
    // Fetch all completed/failed jobs (descending)
    // Note: This relies on retention settings. If retention is global, we might lose history.
    const jobs = await this.queue.getJobs(["completed", "failed"], 0, -1, false);

    return jobs
      .filter((j) => j.data && j.data.cronJobId === cronJobId)
      .slice(0, limit)
      .map((j) => j.returnvalue)
      .filter((v) => v !== null && v !== undefined);
  }
}
