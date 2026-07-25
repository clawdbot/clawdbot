export function parseDockerAllCliArgs(argv: unknown): {
  help: boolean;
  planJson: boolean;
};
export function describeDockerSchedulerLimits(parallelism: unknown, options: unknown): string;
export function canStartSchedulerLane(
  candidate: unknown,
  active: unknown,
  parallelism: unknown,
  options: unknown,
): boolean;
export function githubWorkflowRerunCommand(
  laneNames: unknown,
  ref: unknown,
  env?: NodeJS.ProcessEnv,
): string;
export function writeRunSummary(
  logDir: unknown,
  summary: unknown,
  env?: NodeJS.ProcessEnv,
): Promise<void>;
export function dockerPreflightContainerNames(raw: unknown): unknown;
export function resolveDockerPreflightPlatform(
  arch?: NodeJS.Architecture,
): "linux/arm64" | "linux/amd64";
export function dockerPreflightSmokeCommand(arch?: NodeJS.Architecture): string;
export function runShellCommand({
  command,
  env,
  label,
  logFile,
  timeoutMs,
  noOutputTimeoutMs,
  timeoutKillGraceMs,
}: {
  command: unknown;
  env: unknown;
  label: unknown;
  logFile?: string;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  timeoutKillGraceMs?: number | undefined;
}): unknown;
export function appendBoundedShellCapture(
  current: unknown,
  chunk: unknown,
  maxChars?: number,
): {
  text: string;
  truncated: boolean;
};
export function runShellCaptureCommand({
  command,
  env,
  label,
  timeoutMs,
  timeoutKillGraceMs,
}: {
  command: unknown;
  env: unknown;
  label: unknown;
  timeoutMs: unknown;
  timeoutKillGraceMs?: number | undefined;
}): unknown;
export function runCleanupSmokePhase(
  baseEnv: unknown,
  logDir: unknown,
  phases: unknown,
): Promise<
  | {
      command: unknown;
      attempts: {
        attempt: number;
        elapsedSeconds: number;
        finishedAt: string;
        noOutputTimedOut: boolean;
        startedAt: string;
        status: number;
        timedOut: boolean;
      }[];
      elapsedSeconds: number;
      finishedAt: string;
      image: unknown;
      logFile: string;
      name: string;
      noOutputTimedOut: boolean;
      rerunCommand: unknown;
      startedAt: string;
      status: number;
      targetable: boolean;
      timedOut: boolean;
    }
  | undefined
>;
export function tailFile(file: unknown, lines: unknown, maxBytes?: number): Promise<string>;
export const SHELL_CAPTURE_MAX_CHARS: number;
export const LOG_TAIL_MAX_BYTES: number;
