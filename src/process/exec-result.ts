export type SpawnResult = {
  pid?: number;
  stdout: string;
  stderr: string;
  stdoutTruncatedBytes?: number;
  stderrTruncatedBytes?: number;
  preservedStdoutLines?: string[];
  preservedStderrLines?: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  noOutputTimedOut?: boolean;
  outputLimitExceeded?: boolean;
  outputErrorStream?: "stdout" | "stderr";
};

export const TIMEOUT_EXIT_CODE = 124;

export function createSanitizedCommandError(result: {
  code?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
}): Error {
  const code = typeof result.code === "string" ? result.code : undefined;
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const signal = typeof result.signal === "string" ? result.signal : undefined;
  const message = result.timedOut
    ? "Command timed out"
    : result.isMaxBuffer
      ? "Command output exceeded its capture limit"
      : result.isCanceled
        ? "Command was canceled"
        : result.isTerminated
          ? `Command was terminated${signal ? ` by ${signal}` : ""}`
          : exitCode !== undefined && exitCode !== 0
            ? `Command exited with code ${exitCode}`
            : `Command failed during launch or output capture${code ? ` (${code})` : ""}`;
  return Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function isPlainCommandExitFailure(result: {
  failed: boolean;
  exitCode?: unknown;
  signal?: unknown;
  cause?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
}): boolean {
  return (
    result.failed &&
    typeof result.exitCode === "number" &&
    result.exitCode !== 0 &&
    result.signal === undefined &&
    result.cause === undefined &&
    !result.timedOut &&
    !result.isCanceled &&
    !result.isMaxBuffer &&
    !result.isTerminated
  );
}

export function isPlainCommandSignalFailure(result: {
  failed: boolean;
  exitCode?: unknown;
  signal?: unknown;
  cause?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated?: boolean;
}): boolean {
  return (
    result.failed &&
    result.exitCode === undefined &&
    typeof result.signal === "string" &&
    result.cause === undefined &&
    !result.timedOut &&
    !result.isCanceled &&
    !result.isMaxBuffer &&
    result.isTerminated === true
  );
}

export function resolveProcessExitCode(params: {
  explicitCode: number | null | undefined;
  childExitCode: number | null | undefined;
  resolvedSignal: NodeJS.Signals | null;
  usesWindowsExitCodeShim: boolean;
  timedOut: boolean;
  noOutputTimedOut: boolean;
  killIssuedByTimeout: boolean;
  killIssuedByAbort?: boolean;
}): number | null {
  return (
    params.explicitCode ??
    params.childExitCode ??
    (params.usesWindowsExitCodeShim &&
    params.resolvedSignal == null &&
    !params.timedOut &&
    !params.noOutputTimedOut &&
    !params.killIssuedByTimeout &&
    !params.killIssuedByAbort
      ? 0
      : null)
  );
}
