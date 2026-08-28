/** Child-process wrapper used by daemon installers to preserve stdout/stderr on failure. */
import { extractErrorCode } from "../infra/errors.js";
import { createSanitizedCommandError } from "../process/exec-result.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";

export type ExecResult = Pick<SpawnResult, "stdout" | "stderr"> & {
  code: number;
  termination: SpawnResult["termination"] | "error";
  errorCode?: string;
};

/** Runs a child process as UTF-8 and returns exit data instead of throwing on nonzero exit. */
export async function execFileUtf8(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    killSignal?: NodeJS.Signals | number;
    windowsHide?: boolean;
  } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr, code, termination, signal } = await runCommandWithTimeout(
      [command, ...args],
      {
        baseEnv: options.env,
        cwd: options.cwd,
        killSignal: options.killSignal,
        maxOutputBytes: 1024 * 1024,
        timeoutMs: options.timeout,
      },
    );
    const diagnostic =
      termination === "exit"
        ? ""
        : createSanitizedCommandError({
            timedOut: termination === "timeout" || termination === "no-output-timeout",
            isTerminated: true,
            signal,
          }).message;
    // A child can exit zero while handling termination; daemon actions must still fail.
    return {
      stdout,
      stderr: [stderr, diagnostic].filter(Boolean).join("\n"),
      code: termination === "exit" ? (code ?? 1) : code || 1,
      termination,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = extractErrorCode(error);
    // Launch diagnostics omit argv; preserve errno separately so daemon owners
    // never have to recover execution failures from sanitized prose.
    return { stdout: "", stderr: message, code: 1, termination: "error", errorCode };
  }
}
