// Exec helpers run subprocesses with normalized output, timeout, and abort handling.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { danger, shouldLogVerbose } from "../globals.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { logDebug, logError } from "../logger.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import { killProcessTree as terminateProcessTree } from "./kill-tree.js";
import { resolveCommandStdio } from "./spawn-utils.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
  resolveWindowsCommandShim,
} from "./windows-command.js";

const execFileAsync = promisify(execFile);

function assignChildEnvValue(params: {
  env: NodeJS.ProcessEnv;
  key: string;
  platform: NodeJS.Platform;
  value: string | undefined;
}): void {
  if (params.value === undefined) {
    return;
  }
  if (params.platform === "win32") {
    const normalizedKey = params.key.toLowerCase();
    for (const existingKey of Object.keys(params.env)) {
      if (existingKey.toLowerCase() === normalizedKey && existingKey !== params.key) {
        delete params.env[existingKey];
      }
    }
  }
  params.env[params.key] = params.value;
}

function mergeChildEnv(params: {
  baseEnv: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(params.baseEnv)) {
    assignChildEnvValue({ env: resolvedEnv, key, platform: params.platform, value });
  }
  for (const [key, value] of Object.entries(params.env ?? {})) {
    assignChildEnvValue({ env: resolvedEnv, key, platform: params.platform, value });
  }
  return resolvedEnv;
}

/**
 * On Windows, Node 18.20.2+ (CVE-2024-27980) rejects spawning .cmd/.bat directly
 * without shell, causing EINVAL. Resolve npm/npx to node + cli script so we
 * spawn node.exe instead of npm.cmd.
 */
function resolveNpmArgvForWindows(argv: string[]): string[] | null {
  if (process.platform !== "win32" || argv.length === 0) {
    return null;
  }
  const basename = normalizeLowercaseStringOrEmpty(
    path.basename(expectDefined(argv[0], "argv entry at 0")),
  ).replace(/\.(cmd|exe|bat)$/, "");
  const cliName = basename === "npx" ? "npx-cli.js" : basename === "npm" ? "npm-cli.js" : null;
  if (!cliName) {
    return null;
  }
  const nodeDir = path.dirname(process.execPath);
  const cliPath = path.join(nodeDir, "node_modules", "npm", "bin", cliName);
  if (!fs.existsSync(cliPath)) {
    // Bun-based runs don't ship npm-cli.js next to process.execPath.
    // Fall back to npm.cmd/npx.cmd so we still route through cmd wrapper
    // (avoids direct .cmd spawn EINVAL on patched Node).
    const command = argv[0] ?? "";
    const ext = normalizeLowercaseStringOrEmpty(path.extname(command));
    const shimmedCommand = ext ? command : `${command}.cmd`;
    return [shimmedCommand, ...argv.slice(1)];
  }
  return [process.execPath, cliPath, ...argv.slice(1)];
}

/**
 * Resolves a command for Windows compatibility.
 * On Windows, non-.exe commands (like pnpm, yarn) are resolved to .cmd; npm/npx
 * are handled by resolveNpmArgvForWindows to avoid spawn EINVAL (no direct .cmd).
 */
function resolveCommand(command: string): string {
  return resolveWindowsCommandShim({
    command,
    cmdCommands: ["corepack", "pnpm", "yarn"],
  });
}

function resolveChildProcessInvocation(params: {
  argv: string[];
  windowsVerbatimArguments?: boolean;
}): {
  args: string[];
  command: string;
  usesWindowsExitCodeShim: boolean;
  windowsHide: true;
  windowsVerbatimArguments?: boolean;
} {
  const finalArgv =
    process.platform === "win32"
      ? (resolveNpmArgvForWindows(params.argv) ?? params.argv)
      : params.argv;
  const resolvedCommand =
    finalArgv !== params.argv ? (finalArgv[0] ?? "") : resolveCommand(params.argv[0] ?? "");
  const useCmdWrapper = isWindowsBatchCommand(resolvedCommand);

  return {
    command: useCmdWrapper ? resolveTrustedWindowsCmdExe() : resolvedCommand,
    args: useCmdWrapper
      ? ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))]
      : finalArgv.slice(1),
    usesWindowsExitCodeShim:
      process.platform === "win32" && (useCmdWrapper || finalArgv !== params.argv),
    windowsHide: true,
    windowsVerbatimArguments: useCmdWrapper ? true : params.windowsVerbatimArguments,
  };
}

export function shouldSpawnWithShell(params: {
  resolvedCommand: string;
  platform: NodeJS.Platform;
}): boolean {
  // SECURITY: never enable `shell` for argv-based execution.
  // `shell` routes through cmd.exe on Windows, which turns untrusted argv values
  // (like chat prompts passed as CLI args) into command-injection primitives.
  // If you need a shell, use an explicit shell-wrapper argv (e.g. `cmd.exe /c ...`)
  // and validate/escape at the call site.
  void params;
  return false;
}

// Simple promise-wrapped execFile with optional verbosity logging.
export async function runExec(
  command: string,
  args: string[],
  opts: number | { timeoutMs?: number; maxBuffer?: number; cwd?: string } = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  const options =
    typeof opts === "number"
      ? { timeout: resolveTimerTimeoutMs(opts, 1), encoding: "buffer" as const }
      : {
          timeout:
            typeof opts.timeoutMs === "number"
              ? resolveTimerTimeoutMs(opts.timeoutMs, 1)
              : undefined,
          maxBuffer: opts.maxBuffer,
          cwd: opts.cwd,
          encoding: "buffer" as const,
        };
  try {
    const invocation = resolveChildProcessInvocation({ argv: [command, ...args] });
    const { stdout, stderr } = (await execFileAsync(invocation.command, invocation.args, {
      ...options,
      windowsHide: invocation.windowsHide,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    })) as { stdout: Buffer; stderr: Buffer };
    const windowsEncoding = resolveWindowsConsoleEncoding();
    const decodedStdout = decodeWindowsOutputBuffer({ buffer: stdout, windowsEncoding });
    const decodedStderr = decodeWindowsOutputBuffer({ buffer: stderr, windowsEncoding });
    if (shouldLogVerbose()) {
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
      const errorWithOutput = err as { stdout?: unknown; stderr?: unknown };
      if (Buffer.isBuffer(errorWithOutput.stdout)) {
        errorWithOutput.stdout = decodeWindowsOutputBuffer({
          buffer: errorWithOutput.stdout,
          windowsEncoding,
        });
      }
      if (Buffer.isBuffer(errorWithOutput.stderr)) {
        errorWithOutput.stderr = decodeWindowsOutputBuffer({
          buffer: errorWithOutput.stderr,
          windowsEncoding,
        });
      }
    }
    if (shouldLogVerbose()) {
      logError(danger(`Command failed: ${command} ${args.join(" ")}`));
    }
    throw err;
  }
}

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
};

export type CommandOptions = {
  timeoutMs: number;
  cwd?: string;
  input?: string;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  maxPreservedOutputLines?: number;
  preserveOutputLine?: (line: string, stream: "stdout" | "stderr") => boolean;
  killProcessTree?: boolean;
};

const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;
const WINDOWS_CLOSE_STATE_POLL_MS = 10;
const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;
const TIMEOUT_EXIT_CODE = 124;
const DEFAULT_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PRESERVED_PENDING_LINE_BYTES = 8 * 1024;

type CapturedOutputBuffers = {
  chunks: Buffer[];
  bytes: number;
  truncatedBytes: number;
  preservedLines: string[];
  decoder: StringDecoder;
  pendingLine: string;
};

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMAND_OUTPUT_MAX_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

function appendCapturedOutput(
  capture: CapturedOutputBuffers,
  chunk: Buffer | string,
  maxBytes: number,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (buffer.byteLength >= maxBytes) {
    capture.chunks = [Buffer.from(buffer.subarray(buffer.byteLength - maxBytes))];
    capture.truncatedBytes += capture.bytes + buffer.byteLength - maxBytes;
    capture.bytes = maxBytes;
    return;
  }

  capture.chunks.push(buffer);
  capture.bytes += buffer.byteLength;
  while (capture.bytes > maxBytes && capture.chunks.length > 0) {
    const first = expectDefined(capture.chunks[0], "chunks entry at 0");
    const overflow = capture.bytes - maxBytes;
    if (first.byteLength <= overflow) {
      capture.chunks.shift();
      capture.bytes -= first.byteLength;
      capture.truncatedBytes += first.byteLength;
    } else {
      capture.chunks[0] = Buffer.from(first.subarray(overflow));
      capture.bytes -= overflow;
      capture.truncatedBytes += overflow;
    }
  }
}

function trimPreservedPendingLine(value: string, maxBytes: number): string {
  return truncateUtf8Suffix(value, maxBytes);
}

function appendPreservedOutputLines(params: {
  capture: CapturedOutputBuffers;
  chunk: Buffer | string;
  stream: "stdout" | "stderr";
  preserveOutputLine?: CommandOptions["preserveOutputLine"];
  maxPreservedOutputLines: number;
  maxPendingLineBytes: number;
}): void {
  if (!params.preserveOutputLine || params.maxPreservedOutputLines <= 0) {
    return;
  }
  const text = Buffer.isBuffer(params.chunk)
    ? params.capture.decoder.write(params.chunk)
    : params.chunk;
  if (!text) {
    return;
  }
  const lines = (params.capture.pendingLine + text).split(/\r?\n/);
  params.capture.pendingLine = trimPreservedPendingLine(
    lines.pop() ?? "",
    params.maxPendingLineBytes,
  );
  for (const line of lines) {
    if (
      params.capture.preservedLines.length < params.maxPreservedOutputLines &&
      params.preserveOutputLine(line, params.stream)
    ) {
      params.capture.preservedLines.push(line);
    }
  }
}

function flushPreservedOutputLine(params: {
  capture: CapturedOutputBuffers;
  stream: "stdout" | "stderr";
  preserveOutputLine?: CommandOptions["preserveOutputLine"];
  maxPreservedOutputLines: number;
  maxPendingLineBytes: number;
}): void {
  if (!params.preserveOutputLine || params.maxPreservedOutputLines <= 0) {
    return;
  }
  const trailing = trimPreservedPendingLine(
    params.capture.pendingLine + params.capture.decoder.end(),
    params.maxPendingLineBytes,
  );
  params.capture.pendingLine = "";
  if (
    trailing &&
    params.capture.preservedLines.length < params.maxPreservedOutputLines &&
    params.preserveOutputLine(trailing, params.stream)
  ) {
    params.capture.preservedLines.push(trailing);
  }
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

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
  const platform = params.platform ?? process.platform;
  const argv = params.argv;
  const shouldSuppressNpmFund = (() => {
    const cmd = path.basename(argv[0] ?? "");
    if (cmd === "npm" || cmd === "npm.cmd" || cmd === "npm.exe") {
      return true;
    }
    if (cmd === "node" || cmd === "node.exe") {
      const script = argv[1] ?? "";
      return script.includes("npm-cli.js");
    }
    return false;
  })();

  const resolvedEnv = mergeChildEnv({ baseEnv, env: params.env, platform });
  if (shouldSuppressNpmFund) {
    if (resolvedEnv.NPM_CONFIG_FUND == null) {
      resolvedEnv.NPM_CONFIG_FUND = "false";
    }
    if (resolvedEnv.npm_config_fund == null) {
      resolvedEnv.npm_config_fund = "false";
    }
  }
  return markOpenClawExecEnv(resolvedEnv);
}

export async function runCommandWithTimeout(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<SpawnResult> {
  const options: CommandOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const { timeoutMs, cwd, input, baseEnv, env, noOutputTimeoutMs, signal, killProcessTree } =
    options;
  const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const hasInput = input !== undefined;
  const resolvedEnv = resolveCommandEnv({ argv, baseEnv, env });
  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });
  const invocation = resolveChildProcessInvocation({
    argv,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });

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

  const child = spawn(invocation.command, invocation.args, {
    stdio,
    cwd,
    env: resolvedEnv,
    // Cron shell wrappers need their own process group so timeout/abort kills
    // reach foreground children instead of leaving duplicate scheduled work.
    ...(killProcessTree && process.platform !== "win32" ? { detached: true } : {}),
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(shouldSpawnWithShell({ resolvedCommand: invocation.command, platform: process.platform })
      ? { shell: true }
      : {}),
  });
  // Spawn with inherited stdin (TTY) so interactive tools stay usable when needed.
  return await new Promise((resolve, reject) => {
    const stdoutCapture: CapturedOutputBuffers = {
      chunks: [],
      bytes: 0,
      truncatedBytes: 0,
      preservedLines: [],
      decoder: new StringDecoder("utf8"),
      pendingLine: "",
    };
    const stderrCapture: CapturedOutputBuffers = {
      chunks: [],
      bytes: 0,
      truncatedBytes: 0,
      preservedLines: [],
      decoder: new StringDecoder("utf8"),
      pendingLine: "",
    };
    const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
    const maxPreservedPendingLineBytes = Math.min(maxOutputBytes, MAX_PRESERVED_PENDING_LINE_BYTES);
    const maxPreservedOutputLines = Math.max(0, Math.floor(options.maxPreservedOutputLines ?? 16));
    const windowsEncoding = resolveWindowsConsoleEncoding();
    let settled = false;
    let timedOut = false;
    let noOutputTimedOut = false;
    let killIssuedByTimeout = false;
    let killIssuedByAbort = false;
    let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let closeFallbackTimer: NodeJS.Timeout | null = null;
    let processTreeForceKillTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const shouldTrackOutputTimeout =
      typeof noOutputTimeoutMs === "number" &&
      Number.isFinite(noOutputTimeoutMs) &&
      noOutputTimeoutMs > 0;
    const resolvedNoOutputTimeoutMs = shouldTrackOutputTimeout
      ? resolveTimerTimeoutMs(noOutputTimeoutMs, 1)
      : undefined;
    let removeAbortListener: (() => void) | null = null;

    const clearNoOutputTimer = () => {
      if (!noOutputTimer) {
        return;
      }
      clearTimeout(noOutputTimer);
      noOutputTimer = null;
    };

    const clearCloseFallbackTimer = () => {
      if (!closeFallbackTimer) {
        return;
      }
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    };

    const clearProcessTreeForceKillTimer = () => {
      if (!processTreeForceKillTimer) {
        return;
      }
      clearTimeout(processTreeForceKillTimer);
      processTreeForceKillTimer = null;
    };

    const killDirectChild = () => {
      if (settled || childExitState != null || child.exitCode != null || child.signalCode != null) {
        return;
      }
      child.kill("SIGKILL");
    };

    const spawnTaskkillOrFallback = (args: string[], onSpawnError: () => void): boolean => {
      try {
        const taskkillChild = spawn(getWindowsSystem32ExePath("taskkill.exe"), args, {
          stdio: "ignore",
          windowsHide: true,
        });
        taskkillChild.once("error", onSpawnError);
        return true;
      } catch {
        onSpawnError();
        return false;
      }
    };

    const killChild = (byTimeout = true) => {
      if (settled || typeof child?.kill !== "function") {
        return;
      }
      if (byTimeout) {
        killIssuedByTimeout = true;
      } else {
        killIssuedByAbort = true;
      }
      if (killProcessTree && typeof child.pid === "number" && child.pid > 0) {
        if (process.platform === "win32") {
          const taskkillStarted = spawnTaskkillOrFallback(["/PID", String(child.pid), "/T"], () => {
            clearProcessTreeForceKillTimer();
            killDirectChild();
          });
          if (taskkillStarted) {
            if (!processTreeForceKillTimer) {
              processTreeForceKillTimer = setTimeout(() => {
                processTreeForceKillTimer = null;
                if (
                  settled ||
                  childExitState != null ||
                  child.exitCode != null ||
                  child.signalCode != null
                ) {
                  return;
                }
                spawnTaskkillOrFallback(["/PID", String(child.pid), "/T", "/F"], killDirectChild);
              }, COMMAND_PROCESS_TREE_KILL_GRACE_MS);
              processTreeForceKillTimer.unref();
            }
          }
          return;
        }
        terminateProcessTree(child.pid, { graceMs: COMMAND_PROCESS_TREE_KILL_GRACE_MS });
        return;
      }
      if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
        spawnTaskkillOrFallback(["/PID", String(child.pid), "/T", "/F"], killDirectChild);
        return;
      }
      killDirectChild();
    };

    const armNoOutputTimer = () => {
      if (!shouldTrackOutputTimeout || settled) {
        return;
      }
      clearNoOutputTimer();
      noOutputTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        noOutputTimedOut = true;
        killChild();
      }, resolvedNoOutputTimeoutMs);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, resolvedTimeoutMs);
    armNoOutputTimer();
    if (signal) {
      const onAbort = () => killChild(false);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }

    if (hasInput && child.stdin) {
      // Swallow EPIPE from a prematurely-exited child; the exit handler
      // reports the real status. (#75438)
      child.stdin.on("error", () => {});
      child.stdin.write(input ?? "");
      child.stdin.end();
    }

    // Output pipes may fail independently; child exit/close remains authoritative.
    const ignoreOutputStreamError = () => {};
    child.stdout?.on("error", ignoreOutputStreamError);
    child.stderr?.on("error", ignoreOutputStreamError);
    child.stdout?.on("data", (d) => {
      appendPreservedOutputLines({
        capture: stdoutCapture,
        chunk: d,
        stream: "stdout",
        preserveOutputLine: options.preserveOutputLine,
        maxPreservedOutputLines,
        maxPendingLineBytes: maxPreservedPendingLineBytes,
      });
      appendCapturedOutput(stdoutCapture, d, maxOutputBytes);
      armNoOutputTimer();
    });
    child.stderr?.on("data", (d) => {
      appendPreservedOutputLines({
        capture: stderrCapture,
        chunk: d,
        stream: "stderr",
        preserveOutputLine: options.preserveOutputLine,
        maxPreservedOutputLines,
        maxPendingLineBytes: maxPreservedPendingLineBytes,
      });
      appendCapturedOutput(stderrCapture, d, maxOutputBytes);
      armNoOutputTimer();
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearNoOutputTimer();
      clearCloseFallbackTimer();
      clearProcessTreeForceKillTimer();
      removeAbortListener?.();
      removeAbortListener = null;
      reject(err);
    });
    child.on("exit", (code, signalResult) => {
      childExitState = { code, signal: signalResult };
      clearProcessTreeForceKillTimer();
      if (settled || closeFallbackTimer) {
        return;
      }
      closeFallbackTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 250);
    });
    const resolveFromClose = (code: number | null, signalValue: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearNoOutputTimer();
      clearCloseFallbackTimer();
      clearProcessTreeForceKillTimer();
      removeAbortListener?.();
      removeAbortListener = null;
      const resolvedSignal = childExitState?.signal ?? signalValue ?? child.signalCode ?? null;
      const resolvedCode = resolveProcessExitCode({
        explicitCode: childExitState?.code ?? code,
        childExitCode: child.exitCode,
        resolvedSignal,
        usesWindowsExitCodeShim: invocation.usesWindowsExitCodeShim,
        timedOut,
        noOutputTimedOut,
        killIssuedByTimeout,
        killIssuedByAbort,
      });
      const termination = noOutputTimedOut
        ? "no-output-timeout"
        : timedOut
          ? "timeout"
          : resolvedSignal != null || killIssuedByAbort
            ? "signal"
            : "exit";
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
      resolve({
        pid: child.pid ?? undefined,
        stdout: decodeWindowsOutputBuffer({
          buffer: Buffer.concat(stdoutCapture.chunks, stdoutCapture.bytes),
          windowsEncoding,
        }),
        stderr: decodeWindowsOutputBuffer({
          buffer: Buffer.concat(stderrCapture.chunks, stderrCapture.bytes),
          windowsEncoding,
        }),
        stdoutTruncatedBytes: stdoutCapture.truncatedBytes || undefined,
        stderrTruncatedBytes: stderrCapture.truncatedBytes || undefined,
        preservedStdoutLines:
          stdoutCapture.preservedLines.length > 0 ? stdoutCapture.preservedLines : undefined,
        preservedStderrLines:
          stderrCapture.preservedLines.length > 0 ? stderrCapture.preservedLines : undefined,
        code: normalizedCode,
        signal: resolvedSignal,
        killed: child.killed,
        termination,
        noOutputTimedOut,
      });
    };
    child.on("close", (code, signalLocal) => {
      if (
        process.platform !== "win32" ||
        childExitState != null ||
        code != null ||
        signalLocal != null ||
        child.exitCode != null ||
        child.signalCode != null
      ) {
        resolveFromClose(code, signalLocal);
        return;
      }

      const startedAt = Date.now();
      const waitForExitState = () => {
        if (settled) {
          return;
        }
        if (childExitState != null || child.exitCode != null || child.signalCode != null) {
          resolveFromClose(code, signalLocal);
          return;
        }
        if (Date.now() - startedAt >= WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS) {
          resolveFromClose(code, signalLocal);
          return;
        }
        setTimeout(waitForExitState, WINDOWS_CLOSE_STATE_POLL_MS);
      };
      waitForExitState();
    });
  });
}
