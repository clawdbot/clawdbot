/** Shared cron SQLite store and quarantine types. */
import type { CronStoreFile } from "../types.js";

/** Invalid config-backed cron job captured for quarantine instead of runtime load. */
export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

/** Durable recovery record for a cron job skipped during store loading. */
export type CronQuarantinedJob = QuarantinedCronConfigJob & { quarantinedAtMs: number };

/** Runtime state retained for config-sourced jobs that are not persisted as canonical jobs. */
export type CronConfigJobRuntimeEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

/** Combined cron store load result with canonical jobs and config-backed metadata. */
export type LoadedCronStore = {
  store: CronStoreFile;
  configJobs: Array<Record<string, unknown>>;
  configJobIndexes: number[];
  configJobRuntimeEntries: CronConfigJobRuntimeEntry[];
  invalidConfigRows: QuarantinedCronConfigJob[];
  jobsFingerprint?: string;
};
