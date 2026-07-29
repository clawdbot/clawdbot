/** Shared cron store sidecar and quarantine types. */
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

/** Sidecar file that records config jobs skipped during cron store loading. */
export type CronQuarantineFile = {
  version: 1;
  jobs: Array<QuarantinedCronConfigJob & { quarantinedAtMs: number }>;
};

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
};
