#!/usr/bin/env node
/**
 * Parses plugin gateway gauntlet CLI arguments and env defaults.
 */
export function parseArgs(argv: string[]): {
  repoRoot: string;
  outputDir: string;
  pluginIds: string[];
  shardTotal: number;
  shardIndex: number;
  limit: number | undefined;
  skipPrebuild: boolean;
  skipLifecycle: boolean;
  skipQa: boolean;
  qaBaseline: boolean;
  skipSlashHelp: boolean;
  qaScenarios: string[];
  qaPluginChunkSize: number;
  cpuCoreWarn: number;
  hotWallWarnMs: number;
  maxRssWarnMb: number;
  wallAnomalyMultiplier: number;
  rssAnomalyMultiplier: number;
  qaCpuRegressionMultiplier: number;
  qaWallRegressionMultiplier: number;
  commandTimeoutMs: number;
  buildTimeoutMs: number;
  qaTimeoutMs: number;
  allowEmpty: boolean;
  failOnObservation: boolean;
  keepRunRoot: boolean;
};
export function buildObservationGuardFailures(observations: unknown, enabled?: boolean): unknown;
/**
 * Builds the command that prepares QA runtime artifacts before gauntlet probes.
 */
export function createGauntletPrebuildCommand(repoRoot: unknown): {
  command: string;
  args: string[];
};
/**
 * Converts an output path to a repo-relative path, rejecting paths outside the repo.
 */
export function toRepoRelativePath(repoRoot: unknown, absolutePath: unknown): string;
/**
 * Parses `/usr/bin/time` output into wall, CPU, and RSS metrics.
 */
export function parseTimedMetrics(
  stderr: unknown,
  wallMs: unknown,
  mode: unknown,
): {
  wallMs: unknown;
  cpuMs: number | null;
  cpuCoreRatio: number | null;
  maxRssMb: number | null;
};
/**
 * Runs a measured command through the live process implementation.
 */
export type GauntletMeasuredRow = {
  diagnosticFailure?: string;
  logPath: string | null;
  logWriteError?: string;
  spawnError?: { code?: string };
  status: number;
  timedOut: boolean;
  wallMs: number;
};
export type GauntletMeasuredCommandParams = {
  [key: string]: unknown;
  args: string[];
  command: string;
  consoleOutputMaxBytes?: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logDir: string;
  maxBufferBytes?: number;
  phase: string;
  timeoutKillGraceMs?: number;
  timeoutMs: number;
  timeMode?: string;
};
export function runMeasuredCommand(
  params: GauntletMeasuredCommandParams,
): Promise<GauntletMeasuredRow>;
/**
 * Runs one command with optional timing wrapper, bounded output, and log capture.
 */
export function runMeasuredCommandLive(
  params: GauntletMeasuredCommandParams,
): Promise<GauntletMeasuredRow>;
/**
 * Reports whether gauntlet result rows contain work beyond the prebuild step.
 */
export function hasGauntletWorkRows(rows: unknown): unknown;
