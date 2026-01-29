export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /** Redis URL for BullMQ backend. Defaults to REDIS_URL env or redis://localhost:6379 */
  redisUrl?: string;
  /** BullMQ worker concurrency (default: 3) */
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
