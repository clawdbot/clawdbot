import process from "node:process";
import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { releaseChildProcessOutputAfterExit } from "./child-process.js";
import {
  appendCapturedOutput,
  appendPreservedOutputLines,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
  flushPreservedOutputLine,
  MAX_PRESERVED_PENDING_LINE_BYTES,
  resolveMaxOutputBytes,
  resolveOutputCapture,
  shouldTerminateOnOutputLimit,
  type CapturedOutputBuffers,
  type CommandOutputCaptureMode,
  type CommandOutputCaptureOption,
  type CommandOutputLimitOption,
  type CommandOutputStream,
  type PreserveOutputLine,
} from "./exec-output.js";
import {
  createSanitizedCommandError,
  isPlainCommandExitFailure,
  isPlainCommandSignalFailure,
  resolveProcessExitCode,
  TIMEOUT_EXIT_CODE,
  type SpawnResult,
} from "./exec-result.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS, spawnCommandWithInvocation } from "./exec-spawn.js";
import { createCommandTerminationController } from "./exec-termination.js";
import { resolveCommandStdio } from "./spawn-utils.js";

const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;
const WINDOWS_CLOSE_STATE_POLL_MS = 10;

type CommandTerminationReason = SpawnResult["termination"] | "output-limit";

export type CommandOptions = {
  timeoutMs?: number;
  cwd?: string;
  input?: string | Uint8Array;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number | { stdout?: number; stderr?: number };
  maxCombinedOutputBytes?: number;
  outputCapture?: CommandOutputCaptureOption;
  /** Observe raw output without owning child lifecycle. Return false to stop the command. */
  onOutputChunk?: (chunk: Buffer, stream: CommandOutputStream) => boolean | void;
  /** Accept a successful exit when only the selected diagnostic output stream failed. */
  tolerateOutputError?: { stdout?: boolean; stderr?: boolean };
  terminateOnOutputLimit?: CommandOutputLimitOption;
  maxPreservedOutputLines?: number;
  preserveOutputLine?: PreserveOutputLine;
  killProcessTree?: boolean;
  /** Signal used when terminating the direct child; tree termination owns its own grace policy. */
  killSignal?: NodeJS.Signals | number;
};

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  return await runCommandWithOutputEncoding(argv, optionsOrTimeout, false);
}

/** Run a command whose stdout and stderr are defined to be UTF-8 on every platform. */
export async function runUtf8CommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  return await runCommandWithOutputEncoding(argv, optionsOrTimeout, true);
}

async function runCommandWithOutputEncoding(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
  forceUtf8: boolean,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const {
    timeoutMs,
    cwd,
    input,
    baseEnv,
    env,
    noOutputTimeoutMs,
    signal,
    killProcessTree,
    killSignal,
  } = options;
  const resolvedTimeoutMs =
    typeof timeoutMs === "number" ? resolveTimerTimeoutMs(timeoutMs, 1) : undefined;
  const hasInput = input !== undefined;
  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });

  if (signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      killed: false,
      termination: "signal",
      noOutputTimedOut: false,
    };
  }

  const stdoutCapture = createCapturedOutputBuffers();
  const stderrCapture = createCapturedOutputBuffers();
  const maxStdoutBytes = resolveMaxOutputBytes(options.maxOutputBytes, "stdout");
  const maxStderrBytes = resolveMaxOutputBytes(options.maxOutputBytes, "stderr");
  const maxCombinedOutputBytes =
    typeof options.maxCombinedOutputBytes === "number" &&
    Number.isFinite(options.maxCombinedOutputBytes) &&
    options.maxCombinedOutputBytes > 0
      ? Math.max(1, Math.floor(options.maxCombinedOutputBytes))
      : undefined;
  const stdoutCaptureMode = resolveOutputCapture(options.outputCapture, "stdout");
  const stderrCaptureMode = resolveOutputCapture(options.outputCapture, "stderr");
  if (maxCombinedOutputBytes !== undefined && stdoutCaptureMode !== stderrCaptureMode) {
    throw new Error("maxCombinedOutputBytes requires matching stdout and stderr capture modes");
  }
  const usesCombinedTailCapture =
    maxCombinedOutputBytes !== undefined &&
    stdoutCaptureMode === "tail" &&
    stderrCaptureMode === "tail";
  const maxPreservedPendingLineBytes = Math.min(
    Math.max(maxStdoutBytes, maxStderrBytes),
    MAX_PRESERVED_PENDING_LINE_BYTES,
  );
  const maxPreservedOutputLines = Math.max(0, Math.floor(options.maxPreservedOutputLines ?? 16));
  const windowsEncoding = forceUtf8 ? null : resolveWindowsConsoleEncoding();
  const cancelController = new AbortController();
  let termination: CommandTerminationReason | undefined;
  let childExitState: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let childExited = false;
  let commandSettled = false;
  let combinedOutputBytes = 0;
  let combinedCapturedBytes = 0;
  const outputBytesByStream = { stdout: 0, stderr: 0 };
  const combinedCapturedBytesByStream = { stdout: 0, stderr: 0 };
  const combinedTailChunks: Array<{ stream: CommandOutputStream; buffer: Buffer }> = [];
  let noOutputTimer: NodeJS.Timeout | undefined;
  let outputObserverError: unknown;
  let outputErrorStream: CommandOutputStream | undefined;

  const { child, invocation } = spawnCommandWithInvocation(argv, {
    buffer: false,
    cancelSignal: cancelController.signal,
    cwd,
    detached: Boolean(killProcessTree && process.platform !== "win32"),
    encoding: "buffer",
    baseEnv,
    env,
    forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
    killSignal,
    ...(hasInput ? { input } : {}),
    reject: false,
    stdio,
    stripFinalNewline: false,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });
  const releaseOutput = releaseChildProcessOutputAfterExit(child);
  child.once("exit", (code, signalValue) => {
    childExited = true;
    childExitState = { code, signal: signalValue };
  });
  const terminationController = createCommandTerminationController({
    child,
    cancelController,
    baseEnv,
    env,
    killProcessTree,
    isChildExited: () => childExited,
    isCommandSettled: () => commandSettled,
  });

  const clearNoOutputTimer = () => {
    if (noOutputTimer) {
      clearTimeout(noOutputTimer);
      noOutputTimer = undefined;
    }
  };
  const ownsExitedProcessTree = Boolean(killProcessTree && process.platform !== "win32");
  const cancel = (reason: Exclude<CommandTerminationReason, "exit">) => {
    // Direct exit ends ordinary timer/abort ownership; releaseChildProcessOutputAfterExit
    // still bounds inherited pipes. POSIX tree mode must reap descendants, while
    // output caps remain meaningful for bytes drained after exit.
    if (
      termination ||
      commandSettled ||
      (childExited && reason !== "output-limit" && !ownsExitedProcessTree)
    ) {
      return;
    }
    termination = reason;
    const abortDeferred = terminationController.terminate();
    if (!abortDeferred) {
      cancelController.abort();
    }
  };
  const shouldTrackOutputTimeout =
    typeof noOutputTimeoutMs === "number" &&
    Number.isFinite(noOutputTimeoutMs) &&
    noOutputTimeoutMs > 0;
  const resolvedNoOutputTimeoutMs = shouldTrackOutputTimeout
    ? resolveTimerTimeoutMs(noOutputTimeoutMs, 1)
    : undefined;
  const armNoOutputTimer = () => {
    if (
      resolvedNoOutputTimeoutMs === undefined ||
      commandSettled ||
      termination ||
      (childExited && !ownsExitedProcessTree)
    ) {
      return;
    }
    clearNoOutputTimer();
    noOutputTimer = setTimeout(() => cancel("no-output-timeout"), resolvedNoOutputTimeoutMs);
  };

  const timeoutTimer =
    resolvedTimeoutMs === undefined
      ? undefined
      : setTimeout(() => cancel("timeout"), resolvedTimeoutMs);
  const onAbort = () => cancel("signal");
  signal?.addEventListener("abort", onAbort, { once: true });
  armNoOutputTimer();

  const captureOutput = (
    capture: CapturedOutputBuffers,
    chunk: Buffer | string,
    maxBytes: number,
    stream: CommandOutputStream,
    captureMode: CommandOutputCaptureMode,
  ) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytesByStream[stream] += buffer.byteLength;
    const streamLimitExceeded = outputBytesByStream[stream] > maxBytes;
    if (maxCombinedOutputBytes === undefined) {
      appendCapturedOutput(capture, buffer, maxBytes, captureMode);
      if (
        streamLimitExceeded &&
        shouldTerminateOnOutputLimit(options.terminateOnOutputLimit, stream)
      ) {
        cancel("output-limit");
      }
      return;
    }

    const combinedBytesBeforeChunk = combinedOutputBytes;
    combinedOutputBytes += buffer.byteLength;
    const combinedLimitExceeded = combinedOutputBytes > maxCombinedOutputBytes;
    if (usesCombinedTailCapture) {
      combinedTailChunks.push({ stream, buffer });
      combinedCapturedBytes += buffer.byteLength;
      combinedCapturedBytesByStream[stream] += buffer.byteLength;

      const removeCapturedBytes = (index: number, requestedBytes: number) => {
        const entry = expectDefined(combinedTailChunks[index], "combined tail chunk");
        const removedBytes = Math.min(requestedBytes, entry.buffer.byteLength);
        if (removedBytes === entry.buffer.byteLength) {
          combinedTailChunks.splice(index, 1);
        } else {
          entry.buffer = Buffer.from(entry.buffer.subarray(removedBytes));
        }
        combinedCapturedBytes -= removedBytes;
        combinedCapturedBytesByStream[entry.stream] -= removedBytes;
        (entry.stream === "stdout" ? stdoutCapture : stderrCapture).truncatedBytes += removedBytes;
      };

      while (combinedCapturedBytesByStream[stream] > maxBytes) {
        const index = combinedTailChunks.findIndex((entry) => entry.stream === stream);
        if (index < 0) {
          break;
        }
        removeCapturedBytes(index, combinedCapturedBytesByStream[stream] - maxBytes);
      }
      let combinedOverflow = combinedCapturedBytes - maxCombinedOutputBytes;
      while (combinedOverflow > 0) {
        removeCapturedBytes(0, combinedOverflow);
        combinedOverflow = combinedCapturedBytes - maxCombinedOutputBytes;
      }
    } else {
      const remaining = Math.max(0, maxCombinedOutputBytes - combinedBytesBeforeChunk);
      if (remaining > 0) {
        appendCapturedOutput(capture, buffer.subarray(0, remaining), maxBytes, captureMode);
      }
      capture.truncatedBytes += Math.max(0, buffer.byteLength - remaining);
    }
    if (
      (combinedLimitExceeded &&
        shouldTerminateOnOutputLimit(options.terminateOnOutputLimit, "combined")) ||
      (streamLimitExceeded && shouldTerminateOnOutputLimit(options.terminateOnOutputLimit, stream))
    ) {
      cancel("output-limit");
    }
  };

  const observeOutputChunk = (chunk: Buffer | string, stream: CommandOutputStream): Buffer => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (termination || !options.onOutputChunk) {
      return buffer;
    }
    try {
      if (options.onOutputChunk(buffer, stream) === false) {
        cancel("output-limit");
      }
    } catch (error) {
      outputObserverError = error;
      cancel("output-limit");
    }
    return buffer;
  };

  child.stdout?.once("error", () => {
    outputErrorStream ??= "stdout";
  });
  child.stderr?.once("error", () => {
    outputErrorStream ??= "stderr";
  });
  child.stdout?.on("data", (chunk) => {
    const buffer = observeOutputChunk(chunk, "stdout");
    appendPreservedOutputLines({
      capture: stdoutCapture,
      chunk: buffer,
      stream: "stdout",
      preserveOutputLine: options.preserveOutputLine,
      maxPreservedOutputLines,
      maxPendingLineBytes: maxPreservedPendingLineBytes,
    });
    captureOutput(stdoutCapture, buffer, maxStdoutBytes, "stdout", stdoutCaptureMode);
    armNoOutputTimer();
  });
  child.stderr?.on("data", (chunk) => {
    const buffer = observeOutputChunk(chunk, "stderr");
    appendPreservedOutputLines({
      capture: stderrCapture,
      chunk: buffer,
      stream: "stderr",
      preserveOutputLine: options.preserveOutputLine,
      maxPreservedOutputLines,
      maxPendingLineBytes: maxPreservedPendingLineBytes,
    });
    captureOutput(stderrCapture, buffer, maxStderrBytes, "stderr", stderrCaptureMode);
    armNoOutputTimer();
  });

  const result = await child.finally(() => {
    commandSettled = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    clearNoOutputTimer();
    signal?.removeEventListener("abort", onAbort);
    releaseOutput();
  });
  await terminationController.settle();
  if (outputObserverError !== undefined) {
    throw toErrorObject(outputObserverError, "Command output observer failed");
  }
  // Patched Node can report null/null after a cmd.exe shim exits. Execa turns
  // that into a cause-less failure; preserve the shim fallback only post-spawn.
  const isCauseLessWindowsShimResult =
    !termination &&
    invocation.usesWindowsExitCodeShim &&
    typeof child.pid === "number" &&
    result.code === undefined &&
    result.cause === undefined &&
    !result.timedOut &&
    !result.isCanceled &&
    !result.isMaxBuffer &&
    !result.isTerminated;
  if (isCauseLessWindowsShimResult) {
    // A patched Windows runtime can populate exitCode shortly after close.
    // Settle that state before the shim fallback can infer a clean exit.
    for (
      let elapsedMs = 0;
      elapsedMs < WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS;
      elapsedMs += WINDOWS_CLOSE_STATE_POLL_MS
    ) {
      if (
        childExitState?.code != null ||
        childExitState?.signal != null ||
        child.exitCode != null ||
        child.signalCode != null
      ) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, WINDOWS_CLOSE_STATE_POLL_MS);
      });
    }
  }
  if (
    result.failed &&
    !termination &&
    !isPlainCommandExitFailure(result) &&
    !isPlainCommandSignalFailure(result) &&
    !isCauseLessWindowsShimResult &&
    !(
      result.exitCode === 0 &&
      outputErrorStream !== undefined &&
      options.tolerateOutputError?.[outputErrorStream] === true
    )
  ) {
    const error = createSanitizedCommandError(result);
    if (outputErrorStream) {
      Object.assign(error, { outputErrorStream });
    }
    throw error;
  }

  const resolvedSignal = result.signal ?? childExitState?.signal ?? child.signalCode ?? null;
  const resolvedCode = resolveProcessExitCode({
    explicitCode: result.exitCode ?? childExitState?.code,
    childExitCode: child.exitCode,
    resolvedSignal,
    usesWindowsExitCodeShim: invocation.usesWindowsExitCodeShim,
    timedOut: termination === "timeout",
    noOutputTimedOut: termination === "no-output-timeout",
    killIssuedByTimeout: termination === "timeout" || termination === "no-output-timeout",
    killIssuedByAbort: termination === "signal" || termination === "output-limit",
  });
  termination ??= resolvedSignal != null || result.isTerminated ? "signal" : "exit";
  const normalizedCode =
    termination === "timeout" || termination === "no-output-timeout"
      ? resolvedCode == null || resolvedCode === 0
        ? TIMEOUT_EXIT_CODE
        : resolvedCode
      : resolvedCode;

  flushPreservedOutputLine({
    capture: stdoutCapture,
    stream: "stdout",
    preserveOutputLine: options.preserveOutputLine,
    maxPreservedOutputLines,
    maxPendingLineBytes: maxPreservedPendingLineBytes,
  });
  flushPreservedOutputLine({
    capture: stderrCapture,
    stream: "stderr",
    preserveOutputLine: options.preserveOutputLine,
    maxPreservedOutputLines,
    maxPendingLineBytes: maxPreservedPendingLineBytes,
  });

  if (usesCombinedTailCapture) {
    for (const entry of combinedTailChunks) {
      const capture = entry.stream === "stdout" ? stdoutCapture : stderrCapture;
      capture.chunks.push(entry.buffer);
      capture.bytes += entry.buffer.byteLength;
    }
  }

  const decodeCapturedOutput = (
    capture: CapturedOutputBuffers,
    captureMode: CommandOutputCaptureMode,
  ): string => {
    const buffer = finalizeCapturedOutput(capture, captureMode, forceUtf8);
    return forceUtf8
      ? buffer.toString("utf8")
      : decodeWindowsOutputBuffer({ buffer, windowsEncoding });
  };

  return {
    pid: child.pid,
    stdout: decodeCapturedOutput(stdoutCapture, stdoutCaptureMode),
    stderr: decodeCapturedOutput(stderrCapture, stderrCaptureMode),
    stdoutTruncatedBytes: stdoutCapture.truncatedBytes || undefined,
    stderrTruncatedBytes: stderrCapture.truncatedBytes || undefined,
    preservedStdoutLines:
      stdoutCapture.preservedLines.length > 0 ? stdoutCapture.preservedLines : undefined,
    preservedStderrLines:
      stderrCapture.preservedLines.length > 0 ? stderrCapture.preservedLines : undefined,
    code: normalizedCode,
    signal: resolvedSignal,
    killed: child.killed,
    termination: termination === "output-limit" ? "signal" : termination,
    noOutputTimedOut: termination === "no-output-timeout",
    outputLimitExceeded: termination === "output-limit" || undefined,
    ...(outputErrorStream ? { outputErrorStream } : {}),
  };
}
