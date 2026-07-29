#!/usr/bin/env node
/**
 * Appends watch output while preserving only the diagnostic tail.
 */
export function appendBoundedWatchLog(
  current: unknown,
  chunk: unknown,
  maxChars?: number,
): {
  text: string;
  truncated: boolean;
};
/**
 * Updates bounded watch-build detection state from new output.
 */
export function updateWatchBuildDetection(
  state: unknown,
  chunk: unknown,
): {
  buffer: string;
  triggered: unknown;
  reason: unknown;
};
/**
 * Parses a safe non-negative integer CLI value.
 */
export function readNonNegativeInteger(value: unknown, label: unknown): number;
/**
 * Parses gateway watch regression CLI arguments.
 */
export function parseArgs(argv: unknown): {
  outputDir: string;
  windowMs: number;
  readyTimeoutMs: number;
  readySettleMs: number;
  sigkillGraceMs: number;
  sigkillExitGraceMs: number;
  cpuWarnMs: number;
  cpuFailMs: number;
  distRuntimeFileGrowthMax: number;
  distRuntimeByteGrowthMax: number;
  keepLogs: boolean;
  skipBuild: boolean;
};
/**
 * Reports whether gateway watch output contains a ready marker.
 */
export function hasGatewayReadyLog(text: unknown): boolean;
export function resolveTimedWatchShell(deps?: Record<string, unknown>): string;
export function buildTimedWatchCommand(
  pidFilePath: unknown,
  timeFilePath: unknown,
  isolatedHomeDir: unknown,
  port: unknown,
  deps?: Record<string, unknown>,
):
  | {
      command: string;
      args: unknown[];
      env: {
        OPENCLAW_DISABLE_BONJOUR: string;
        OPENCLAW_SKIP_ACPX_RUNTIME: string;
        OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: string;
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: string;
        OPENCLAW_SKIP_CANVAS_HOST: string;
        OPENCLAW_SKIP_CHANNELS: string;
        OPENCLAW_SKIP_CRON: string;
        OPENCLAW_SKIP_GMAIL_WATCHER: string;
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: string;
        OPENCLAW_TEST_MINIMAL_GATEWAY: string;
        NODE_ENV: string;
        OPENCLAW_WATCH_PID_FILE: unknown;
        HOME: unknown;
        OPENCLAW_HOME: unknown;
        OPENCLAW_CONFIG_PATH: string;
        OPENCLAW_STATE_DIR: string;
        PATH: string;
        XDG_CONFIG_HOME: string;
      };
    }
  | {
      command: unknown;
      args: string[];
      env: {
        OPENCLAW_DISABLE_BONJOUR: string;
        OPENCLAW_SKIP_ACPX_RUNTIME: string;
        OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: string;
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: string;
        OPENCLAW_SKIP_CANVAS_HOST: string;
        OPENCLAW_SKIP_CHANNELS: string;
        OPENCLAW_SKIP_CRON: string;
        OPENCLAW_SKIP_GMAIL_WATCHER: string;
        OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: string;
        OPENCLAW_TEST_MINIMAL_GATEWAY: string;
        NODE_ENV: string;
        OPENCLAW_WATCH_PID_FILE: unknown;
        HOME: unknown;
        OPENCLAW_HOME: unknown;
        OPENCLAW_CONFIG_PATH: string;
        OPENCLAW_STATE_DIR: string;
        PATH: string;
        XDG_CONFIG_HOME: string;
      };
    };
/**
 * Runs a bounded gateway watch process and captures timing/log artifacts.
 */
export function runTimedWatch(
  options: unknown,
  outputDir: unknown,
  deps?: Record<string, unknown>,
): Promise<{
  exit: unknown;
  spawnError: unknown;
  timingFileMissing: boolean;
  timing: unknown;
  readyBeforeWindow: boolean;
  exitedBeforeReady: boolean;
  exitedBeforeStop: boolean;
  idleCpuMs: number | null;
  stdoutPath: string;
  stderrPath: string;
  timeFilePath: string;
  watchTriggeredBuild: boolean;
  watchBuildReason: string | null;
}>;
/**
 * Stops the timed watch child process with TERM/KILL fallback.
 */
export function stopTimedWatchChild(
  child: unknown,
  watchPid: unknown,
  options: unknown,
  deps?: Record<string, unknown>,
): Promise<unknown>;
/**
 * Reports whether restored CI artifacts need fresh build stamps.
 */
export function shouldRefreshBuildStampForRestoredArtifacts(params: unknown): boolean;
/**
 * Writes build and runtime-postbuild stamps for the current artifact set.
 */
export function writeBuildAndRuntimePostBuildStamps(params?: Record<string, unknown>): void;
/**
 * Collects pass/fail findings for the bounded gateway watch regression run.
 */
export function collectGatewayWatchFindings(params: unknown): {
  failures: string[];
  warnings: string[];
};
export function shouldReportDuplicateDistRuntimeRegression(failures: unknown): unknown;
/**
 * Maximum retained stdout/stderr text for gateway watch diagnostics.
 */
export const WATCH_LOG_CAPTURE_MAX_CHARS: number;
export const WATCH_LOG_FAILURE_TAIL_CHARS: 12000;
