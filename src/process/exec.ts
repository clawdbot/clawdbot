// Exec helpers run subprocesses with normalized output, timeout, and abort handling.
import { danger, shouldLogVerbose } from "../globals.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { logDebug, logError } from "../logger.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { releaseChildProcessOutputAfterExit } from "./child-process.js";
import { resolveMaxOutputBytes, type CommandOutputStream } from "./exec-output.js";
import { runCommandWithTimeout } from "./exec-runner.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS, spawnCommand } from "./exec-spawn.js";
export { runCommandWithTimeout, runUtf8CommandWithTimeout } from "./exec-runner.js";
export type { CommandOptions } from "./exec-runner.js";
export { isPlainCommandExitFailure, resolveProcessExitCode } from "./exec-result.js";
export type { SpawnResult } from "./exec-result.js";
export { resolveCommandEnv, shouldSpawnWithShell, spawnCommand } from "./exec-spawn.js";

const DEFAULT_EXEC_MAX_BUFFER_BYTES = 1024 * 1024;

export type RunExecOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
  logOutput?: boolean;
  cwd?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  signal?: AbortSignal;
};

// Simple promise-wrapped execFile with optional verbosity logging.
export async function runExec(
  command: string,
  args: string[],
  opts: number | RunExecOptions = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const timeout =
    typeof opts === "number"
      ? resolveTimerTimeoutMs(opts, 1)
      : typeof opts.timeoutMs === "number"
        ? resolveTimerTimeoutMs(opts.timeoutMs, 1)
        : undefined;
  const maxBuffer =
    typeof opts === "number"
      ? DEFAULT_EXEC_MAX_BUFFER_BYTES
      : (opts.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER_BYTES);
  const resolvedOptions = typeof opts === "number" ? undefined : opts;
  try {
    const subprocess = spawnCommand([command, ...args], {
      baseEnv: resolvedOptions?.baseEnv,
      cancelSignal: resolvedOptions?.signal,
      cwd: resolvedOptions?.cwd,
      encoding: "buffer",
      env: resolvedOptions?.env,
      forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
      ...(resolvedOptions?.input !== undefined ? { input: resolvedOptions.input } : {}),
      maxBuffer,
      reject: true,
      stdin: resolvedOptions?.input === undefined ? "ignore" : undefined,
      stripFinalNewline: false,
      timeout,
    });
    const releaseOutput = releaseChildProcessOutputAfterExit(subprocess.nodeChildProcess);
    const { stdout, stderr } = await subprocess.finally(releaseOutput);
    const windowsEncoding = resolveWindowsConsoleEncoding();
    const decodedStdout = decodeWindowsOutputBuffer({
      buffer: Buffer.from(stdout),
      windowsEncoding,
    });
    const decodedStderr = decodeWindowsOutputBuffer({
      buffer: Buffer.from(stderr),
      windowsEncoding,
    });
    if (resolvedOptions?.logOutput !== false && shouldLogVerbose()) {
      if (decodedStdout.trim()) {
        logDebug(decodedStdout.trim());
      }
      if (decodedStderr.trim()) {
        logError(decodedStderr.trim());
      }
    }
    return { stdout: decodedStdout, stderr: decodedStderr };
  } catch (err) {
    const windowsEncoding = resolveWindowsConsoleEncoding();
    if (err && typeof err === "object") {
      const errorWithOutput = err as {
        code?: string | number;
        exitCode?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      if (errorWithOutput.code === undefined && typeof errorWithOutput.exitCode === "number") {
        errorWithOutput.code = errorWithOutput.exitCode;
      }
      if (errorWithOutput.stdout instanceof Uint8Array) {
        errorWithOutput.stdout = decodeWindowsOutputBuffer({
          buffer: Buffer.from(errorWithOutput.stdout),
          windowsEncoding,
        });
      }
      if (errorWithOutput.stderr instanceof Uint8Array) {
        errorWithOutput.stderr = decodeWindowsOutputBuffer({
          buffer: Buffer.from(errorWithOutput.stderr),
          windowsEncoding,
        });
      }
    }
    if (resolvedOptions?.logOutput !== false && shouldLogVerbose()) {
      logError(danger(`Command failed: ${command}`));
    }
    throw err;
  }
}

type BufferedCommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  input?: string | Uint8Array;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number | { stdout?: number; stderr?: number };
  discardOutput?: { stdout?: boolean; stderr?: boolean };
  tolerateOutputError?: { stdout?: boolean; stderr?: boolean };
};

type BufferedCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "signal" | "output-limit" | "error";
  outputLimitStream?: CommandOutputStream;
  errorStream?: CommandOutputStream;
  error?: Error;
};

/** Run a one-shot command with raw, independently capped stdout and stderr buffers. */
export async function runCommandBuffered(
  argv: string[],
  options: BufferedCommandOptions = {},
): Promise<BufferedCommandResult> {
  if (options.signal?.aborted) {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: null,
      signal: null,
      killed: false,
      termination: "signal",
      ...(options.signal.reason instanceof Error ? { error: options.signal.reason } : {}),
    };
  }

  const chunks: Record<CommandOutputStream, Buffer[]> = { stdout: [], stderr: [] };
  const capturedBytes: Record<CommandOutputStream, number> = { stdout: 0, stderr: 0 };
  let outputLimitStream: CommandOutputStream | undefined;
  const appendChunk = (chunk: Buffer, stream: CommandOutputStream): boolean => {
    if (options.discardOutput?.[stream]) {
      return true;
    }
    const maxBytes = resolveMaxOutputBytes(options.maxOutputBytes, stream);
    const remaining = Math.max(0, maxBytes - capturedBytes[stream]);
    if (remaining > 0) {
      const captured = Buffer.from(chunk.subarray(0, remaining));
      chunks[stream].push(captured);
      capturedBytes[stream] += captured.byteLength;
    }
    if (chunk.byteLength > remaining) {
      outputLimitStream ??= stream;
      return false;
    }
    return true;
  };
  const capturedOutput = (stream: CommandOutputStream) =>
    Buffer.concat(chunks[stream], capturedBytes[stream]);

  try {
    const result = await runCommandWithTimeout(argv, {
      baseEnv: options.baseEnv,
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      killProcessTree: true,
      onOutputChunk: appendChunk,
      outputCapture: "discard",
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      tolerateOutputError: {
        stdout: options.discardOutput?.stdout || options.tolerateOutputError?.stdout,
        stderr: options.discardOutput?.stderr || options.tolerateOutputError?.stderr,
      },
    });
    const termination: BufferedCommandResult["termination"] = result.outputLimitExceeded
      ? "output-limit"
      : result.termination === "no-output-timeout"
        ? "timeout"
        : result.termination;
    return {
      stdout: capturedOutput("stdout"),
      stderr: capturedOutput("stderr"),
      code: termination === "exit" ? result.code : null,
      signal: result.signal,
      killed: result.killed,
      termination,
      ...(outputLimitStream ? { outputLimitStream } : {}),
      ...(result.outputErrorStream ? { errorStream: result.outputErrorStream } : {}),
    };
  } catch (error) {
    const commandError = error instanceof Error ? error : new Error("Command execution failed");
    const metadata = commandError as Error & {
      exitCode?: unknown;
      outputErrorStream?: unknown;
    };
    const errorStream =
      metadata.outputErrorStream === "stdout" || metadata.outputErrorStream === "stderr"
        ? metadata.outputErrorStream
        : undefined;
    return {
      stdout: capturedOutput("stdout"),
      stderr: capturedOutput("stderr"),
      code: typeof metadata.exitCode === "number" ? metadata.exitCode : null,
      signal: null,
      killed: false,
      termination: "error",
      ...(errorStream ? { errorStream } : {}),
      error: commandError,
    };
  }
}
