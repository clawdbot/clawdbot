#!/usr/bin/env node
/**
 * Resolves the configured boundary-check concurrency.
 */
export type BoundaryCheck = { args: string[]; command: string; label: string };
export function resolveConcurrency(value: unknown, fallback?: number, label?: string): number;
/**
 * Parses positive integer CLI/env options with a fallback.
 */
export function resolvePositiveInteger(value: unknown, fallback: number, label?: string): number;
/**
 * Parses one N/TOTAL shard selector into zero-based index form.
 */
export function parseShardSpec(value: unknown): {
  count: number;
  index: number;
  label: string;
} | null;
/**
 * Parses a comma-separated list of N/TOTAL shard selectors.
 */
export function parseShardSelection(value: unknown):
  | {
      count: number;
      index: number;
      label: string;
    }[]
  | null;
/**
 * Selects checks whose ordinal belongs to the requested shard set.
 */
export function selectChecksForShard(checks: BoundaryCheck[], shardSpec: string): BoundaryCheck[];
/**
 * Formats a check command for CI group output.
 */
export function formatCommand({ command, args }: { command: string; args: string[] }): string;
/**
 * Keeps only the tail of noisy check output so failure logs stay bounded.
 */
export function createBoundedOutputBuffer(maxBytes?: number): {
  append: (value: unknown) => void;
  read(): string;
};
/**
 * Runs one boundary check with timeout and process-group termination.
 */
export function runSingleCheck(
  check: BoundaryCheck,
  {
    activeChildren,
    checkTimeoutMs,
    cwd,
    env,
    outputMaxBytes,
  }: {
    activeChildren?: Set<unknown>;
    checkTimeoutMs?: number | undefined;
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputMaxBytes?: number | undefined;
  },
): Promise<{ code: number; durationMs: number; output: string; timedOut: boolean }>;
/**
 * Runs boundary checks with bounded concurrency and returns the failure count.
 */
export function runChecks(
  checks?: BoundaryCheck[],
  {
    checkTimeoutMs,
    concurrency,
    cwd,
    env,
    output,
    outputMaxBytes,
  }?: {
    checkTimeoutMs?: number | undefined;
    concurrency?: number | undefined;
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    output?: { write(chunk: string): boolean } | undefined;
    outputMaxBytes?: number | undefined;
  },
): Promise<number>;
export function parseCliArgs(
  args: unknown,
  env?: NodeJS.ProcessEnv,
): {
  help: boolean;
  shardSpec: string;
};
/** Ordered list of supplemental boundary checks used by CI sharding. */
export const BOUNDARY_CHECKS: {
  label: string;
  command: string;
  args: string[];
}[];
