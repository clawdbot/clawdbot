#!/usr/bin/env node
export function isRetryableGhJsonErrorMessage(message: unknown): boolean;
/**
 * Flattens paginated GitHub run job responses.
 */
export function collectRunJobsFromPages(
  pages: Array<{ jobs?: Array<Record<string, unknown>> }>,
): Array<Record<string, unknown>>;
/**
 * Summarizes longest jobs and total timing for a workflow run.
 */
export function summarizeRunTimings(
  run: unknown,
  limit?: number,
): {
  byDuration: Array<{ name: string; durationSeconds: number }>;
  byQueue: Array<{ name: string; queueSeconds: number }>;
  conclusion: unknown;
  status: unknown;
  wallSeconds: number | null;
  badJobs: unknown;
};
/**
 * Summarizes pnpm store warmup overlap near run start.
 */
export function summarizePnpmStoreWarmupBarrier(
  run: unknown,
  windowSeconds?: number,
): {
  activePostWarmupJobCount: unknown;
  firstPostWarmupStartDelaySeconds: number | null;
  postWarmupP95StartDelaySeconds: unknown;
  postWarmupStartedWithinWindow: unknown;
  preflightToWarmupCompleteSeconds: number | null;
  preflightToWarmupStartSeconds: number | null;
  warmupDurationSeconds: number | null;
  warmupResult: string;
  windowSeconds: number;
} | null;
/**
 * Selects the latest main push CI run, optionally matching a head SHA.
 */
export function selectLatestMainPushCiRun(
  runs: Array<Record<string, unknown>>,
  headSha?: string | null,
): Record<string, unknown> | null;
/**
 * Parses CI run timing CLI arguments.
 */
export function parseRunTimingArgs(args: unknown): {
  explicitRunId: unknown;
  limit: number;
  recentLimit: number | null;
  useLatestMain: boolean;
};
