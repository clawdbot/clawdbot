/** Child-process wrapper used by daemon installers to preserve stdout/stderr on failure. */
import { runCommandWithTimeout } from "../process/exec.js";

type ExecResult = { stdout: string; stderr: string; code: number };

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
    const result = await runCommandWithTimeout([command, ...args], {
      baseEnv: options.env,
      cwd: options.cwd,
      killSignal: options.killSignal,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: options.timeout,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: message, code: 1 };
  }
}
