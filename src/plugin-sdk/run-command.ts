// Run command helpers execute plugin commands with normalized errors and captured output.
import { formatErrorMessage } from "../infra/errors.js";
import { runCommandWithTimeout } from "../process/exec.js";

/** Captured process result returned by plugin command execution helpers. */
export type PluginCommandRunResult = {
  /** Process exit code, with `1` used when the command failed before spawning or did not report one. */
  code: number;
  /** Captured standard output as UTF-8 text. */
  stdout: string;
  /** Captured standard error, normalized to include timeout or thrown-error messages. */
  stderr: string;
};

/** Options for commands that are launched on behalf of a plugin runtime. */
export type PluginCommandRunOptions = {
  /** Executable and arguments, with the command name in the first slot. */
  argv: string[];
  /** Hard execution limit in milliseconds before the command is terminated. */
  timeoutMs: number;
  /** Working directory for the child process. Defaults to the current process directory. */
  cwd?: string;
  /** Environment passed to the child process. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
};

/** Run a plugin-managed command with timeout handling and normalized stdout/stderr results. */
export async function runPluginCommandWithTimeout(
  options: PluginCommandRunOptions,
): Promise<PluginCommandRunResult> {
  const [command] = options.argv;
  if (!command) {
    return { code: 1, stdout: "", stderr: "command is required" };
  }

  try {
    const result = await runCommandWithTimeout(options.argv, {
      timeoutMs: options.timeoutMs,
      cwd: options.cwd,
      env: options.env,
    });
    const timedOut = result.termination === "timeout" || result.termination === "no-output-timeout";
    return {
      code: result.code ?? 1,
      stdout: result.stdout,
      stderr: timedOut
        ? result.stderr || `command timed out after ${options.timeoutMs}ms`
        : result.stderr,
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: formatErrorMessage(error),
    };
  }
}
