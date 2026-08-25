/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { releaseChildProcessOutputAfterExit } from "../../process/child-process.js";
import { spawnCommand } from "../../process/exec.js";
import { killProcessTree } from "../../process/kill-tree.js";

const DEFAULT_OUTPUT_LIMIT_CHARS = 16 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 5000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
  /**
   * AbortSignal to cancel the command. Firing this signal rejects the
   * returned promise with an "Operation aborted" error (the process is
   * killed first); it never resolves as a completed/killed result.
   */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Optional maximum retained stdout/stderr characters per stream. */
  maxOutputChars?: number;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  stdoutTruncatedChars?: number;
  stderrTruncatedChars?: number;
  outputLimitExceeded?: "stdout" | "stderr";
  code: number;
  /** True when `timeout` or the output-limit guard killed the process. Caller-initiated `signal` cancellation rejects instead of resolving here. */
  killed: boolean;
}

type OutputCapture = {
  text: string;
  truncatedChars: number;
};
type OutputDecoder = ReturnType<typeof createWindowsOutputDecoder>;

function decodeCapturedOutput(decoder: OutputDecoder, chunk: Buffer | string): string {
  return Buffer.isBuffer(chunk) ? decoder.decode(chunk) : `${decoder.flush()}${chunk}`;
}

function clampMaxOutputChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_OUTPUT_LIMIT_CHARS;
  }
  return Math.max(1, Math.floor(value));
}

function appendCapturedOutput(
  current: OutputCapture,
  chunk: Buffer | string,
  maxOutputChars: number,
  truncateTail: boolean,
): OutputCapture {
  const text = String(chunk);
  const combined = `${current.text}${text}`;
  const overflowChars = Math.max(0, combined.length - maxOutputChars);
  if (overflowChars === 0) {
    return {
      text: combined,
      truncatedChars: current.truncatedChars,
    };
  }
  const nextText = truncateTail
    ? sliceUtf16Safe(combined, overflowChars)
    : sliceUtf16Safe(combined, 0, maxOutputChars);
  return {
    text: nextText,
    truncatedChars: current.truncatedChars + combined.length - nextText.length,
  };
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
  command: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const proc = spawnCommand([command, ...args], {
      buffer: false,
      cwd,
      detached: process.platform !== "win32",
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const releaseOutput = releaseChildProcessOutputAfterExit(proc.nodeChildProcess);

    let stdout: OutputCapture = { text: "", truncatedChars: 0 };
    let stderr: OutputCapture = { text: "", truncatedChars: 0 };
    const stdoutDecoder = createWindowsOutputDecoder({ preserveUtf8Bom: true });
    const stderrDecoder = createWindowsOutputDecoder({ preserveUtf8Bom: true });
    let killed = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let settled = false;
    // Distinct from `settled`: abortRequested() now settles the caller's
    // promise immediately, before the OS process has actually exited, so the
    // SIGKILL-fallback guard in killProcess() needs its own signal for "has
    // the process actually exited" rather than "has the promise settled".
    let processExited = false;
    const maxOutputChars = clampMaxOutputChars(options?.maxOutputChars);
    const truncateOutput = options?.maxOutputChars !== undefined;
    let outputLimitExceeded: "stdout" | "stderr" | undefined;
    const markOutputLimitExceeded = (stream: "stdout" | "stderr") => {
      if (!truncateOutput && !outputLimitExceeded) {
        outputLimitExceeded = stream;
        killProcess();
      }
    };
    const finish = (code: number) => {
      processExited = true;
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (options?.signal) {
        options.signal.removeEventListener("abort", abortRequested);
      }
      const stdoutBeforeFlush = stdout.truncatedChars;
      stdout = appendCapturedOutput(stdout, stdoutDecoder.flush(), maxOutputChars, truncateOutput);
      if (!truncateOutput && stdout.truncatedChars > stdoutBeforeFlush && !outputLimitExceeded) {
        outputLimitExceeded = "stdout";
      }
      const stderrBeforeFlush = stderr.truncatedChars;
      stderr = appendCapturedOutput(stderr, stderrDecoder.flush(), maxOutputChars, truncateOutput);
      if (!truncateOutput && stderr.truncatedChars > stderrBeforeFlush && !outputLimitExceeded) {
        outputLimitExceeded = "stderr";
      }
      if (outputLimitExceeded) {
        stderr = appendCapturedOutput(
          stderr,
          `${stderr.text ? "\n" : ""}exec ${outputLimitExceeded} exceeded output limit ${maxOutputChars} chars`,
          maxOutputChars,
          true,
        );
      }
      resolve({
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncatedChars: stdout.truncatedChars || undefined,
        stderrTruncatedChars: stderr.truncatedChars || undefined,
        outputLimitExceeded,
        code: outputLimitExceeded ? 1 : code,
        killed,
      });
    };

    const killProcess = () => {
      if (!killed) {
        killed = true;
        if (proc.pid) {
          killProcessTree(proc.pid, {
            detached: process.platform !== "win32",
            graceMs: FORCE_KILL_GRACE_MS,
          });
        } else {
          proc.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (!processExited) {
              proc.kill("SIGKILL");
            }
          }, FORCE_KILL_GRACE_MS);
          forceKillTimer.unref?.();
        }
      }
    };

    // Handle abort signal. Already-aborted signals are rejected before spawning
    // (see top of this Promise executor), so by this point the signal, if any,
    // is guaranteed not yet aborted -- only a later `abort` event can fire.
    //
    // Settle the caller here, not in `finish()`: `finish()` only runs once the
    // child process actually exits, so a caller cancelling mid-grace-period
    // (killProcessTree's SIGTERM-then-SIGKILL window, or a genuinely stuck
    // process) would otherwise stay pending well past the point they cancelled.
    // Don't clear `forceKillTimer` here -- that timer's SIGKILL fallback must
    // keep running against the real OS process regardless of promise state.
    const abortRequested = () => {
      killProcess();
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options?.signal?.removeEventListener("abort", abortRequested);
      reject(new Error("Operation aborted"));
    };
    options?.signal?.addEventListener("abort", abortRequested, { once: true });

    // Handle timeout
    if (options?.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        killProcess();
      }, options.timeout);
    }

    // Output pipes may fail independently; process termination remains authoritative.
    const ignoreOutputStreamError = () => {};
    proc.stdout?.on("error", ignoreOutputStreamError);
    proc.stderr?.on("error", ignoreOutputStreamError);

    proc.stdout?.on("data", (data) => {
      const before = stdout.truncatedChars;
      stdout = appendCapturedOutput(
        stdout,
        decodeCapturedOutput(stdoutDecoder, data),
        maxOutputChars,
        truncateOutput,
      );
      if (stdout.truncatedChars > before) {
        markOutputLimitExceeded("stdout");
      }
    });

    proc.stderr?.on("data", (data) => {
      const before = stderr.truncatedChars;
      stderr = appendCapturedOutput(
        stderr,
        decodeCapturedOutput(stderrDecoder, data),
        maxOutputChars,
        truncateOutput,
      );
      if (stderr.truncatedChars > before) {
        markOutputLimitExceeded("stderr");
      }
    });

    void proc
      .then((result) => {
        finish(result.exitCode ?? (result.failed ? 1 : 0));
      })
      .catch(() => {
        finish(1);
      })
      .finally(releaseOutput);
  });
}
