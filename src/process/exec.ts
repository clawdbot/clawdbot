import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { danger, shouldLogVerbose } from "../globals.js";
import { markOpenClawExecEnv } from "../infra/openclaw-exec-env.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { getWindowsInstallRoots } from "../infra/windows-install-roots.js";
import { logDebug, logError } from "../logger.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveCommandStdio } from "./spawn-utils.js";
import { resolveWindowsCommandShim } from "./windows-command.js";

const execFileAsync = promisify(execFile);

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>^%\r\n]/;

function isWindowsBatchCommand(resolvedCommand: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(resolvedCommand));
  return ext === ".cmd" || ext === ".bat";
}

function escapeForCmdExe(arg: string): string {
  // Reject cmd metacharacters to avoid injection when we must pass a single command line.
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Pass an explicit shell-wrapper argv at the call site instead.",
    );
  }
  // Quote when needed; double inner quotes for cmd parsing.
  if (!arg.includes(" ") && !arg.includes('"')) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

function buildCmdExeCommandLine(resolvedCommand: string, args: string[]): string {
  return [escapeForCmdExe(resolvedCommand), ...args.map(escapeForCmdExe)].join(" ");
}

function resolveTrustedWindowsCmdExe(): string {
  if (process.platform !== "win32") {
    return "cmd.exe";
  }
  return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
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
  const basename = normalizeLowercaseStringOrEmpty(path.basename(argv[0])).replace(
    /\.(cmd|exe|bat)$/,
    "",
  );
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
      ? ["/d", "/s", "/c", buildCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))]
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
      ? { timeout: opts, encoding: "buffer" as const }
      : {
          timeout: opts.timeoutMs,
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
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
  noOutputTimeoutMs?: number;
};

const WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS = 250;
const WINDOWS_CLOSE_STATE_POLL_MS = 10;

export function resolveProcessExitCode(params: {
  explicitCode: number | null | undefined;
  childExitCode: number | null | undefined;
  resolvedSignal: NodeJS.Signals | null;
  usesWindowsExitCodeShim: boolean;
  timedOut: boolean;
  noOutputTimedOut: boolean;
  killIssuedByTimeout: boolean;
}): number | null {
  return (
    params.explicitCode ??
    params.childExitCode ??
    (params.usesWindowsExitCodeShim &&
    params.resolvedSignal == null &&
    !params.timedOut &&
    !params.noOutputTimedOut &&
    !params.killIssuedByTimeout
      ? 0
      : null)
  );
}

export function resolveCommandEnv(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const baseEnv = params.baseEnv ?? process.env;
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

  const mergedEnv = params.env ? { ...baseEnv, ...params.env } : { ...baseEnv };
  const resolvedEnv = Object.fromEntries(
    Object.entries(mergedEnv)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
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
  const { timeoutMs, cwd, input, env, noOutputTimeoutMs } = options;
  const hasInput = input !== undefined;
  const resolvedEnv = resolveCommandEnv({ argv, env });
  const stdio = resolveCommandStdio({ hasInput, preferInherit: true });
  const invocation = resolveChildProcessInvocation({
    argv,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });

  const child = spawn(invocation.command, invocation.args, {
    stdio,
    cwd,
    env: resolvedEnv,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    ...(shouldSpawnWithShell({ resolvedCommand: invocation.command, platform: process.platform })
      ? { shell: true }
      : {}),
  });
  // Spawn with inherited stdin (TTY) so tools like `pi` stay interactive when needed.
  return await new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const windowsEncoding = resolveWindowsConsoleEncoding();
    let settled = false;
    let timedOut = false;
    let noOutputTimedOut = false;
    let killIssuedByTimeout = false;
    let childExitState: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let closeFallbackTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const shouldTrackOutputTimeout =
      typeof noOutputTimeoutMs === "number" &&
      Number.isFinite(noOutputTimeoutMs) &&
      noOutputTimeoutMs > 0;

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

    const killChild = () => {
      if (settled || typeof child?.kill !== "function") {
        return;
      }
      killIssuedByTimeout = true;
      if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
        try {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          return;
        } catch {
          // Fall through to Node's direct child kill as a last resort.
        }
      }
      child.kill("SIGKILL");
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
      }, Math.floor(noOutputTimeoutMs));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    armNoOutputTimer();

    if (hasInput && child.stdin) {
      // Swallow EPIPE from a prematurely-exited child; the exit handler
      // reports the real status. (#75438)
      child.stdin.on("error", () => {});
      child.stdin.write(input ?? "");
      child.stdin.end();
    }

    child.stdout?.on("data", (d) => {
      stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      armNoOutputTimer();
    });
    child.stderr?.on("data", (d) => {
      stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
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
      reject(err);
    });
    child.on("exit", (code, signal) => {
      childExitState = { code, signal };
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
    const resolveFromClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearNoOutputTimer();
      clearCloseFallbackTimer();
      const resolvedSignal = childExitState?.signal ?? signal ?? child.signalCode ?? null;
      const resolvedCode = resolveProcessExitCode({
        explicitCode: childExitState?.code ?? code,
        childExitCode: child.exitCode,
        resolvedSignal,
        usesWindowsExitCodeShim: invocation.usesWindowsExitCodeShim,
        timedOut,
        noOutputTimedOut,
        killIssuedByTimeout,
      });
      const termination = noOutputTimedOut
        ? "no-output-timeout"
        : timedOut
          ? "timeout"
          : resolvedSignal != null
            ? "signal"
            : "exit";
      const normalizedCode =
        termination === "timeout" || termination === "no-output-timeout"
          ? resolvedCode === 0
            ? 124
            : resolvedCode
          : resolvedCode;
      resolve({
        pid: child.pid ?? undefined,
        stdout: decodeWindowsOutputBuffer({
          buffer: Buffer.concat(stdoutChunks),
          windowsEncoding,
        }),
        stderr: decodeWindowsOutputBuffer({
          buffer: Buffer.concat(stderrChunks),
          windowsEncoding,
        }),
        code: normalizedCode,
        signal: resolvedSignal,
        killed: child.killed,
        termination,
        noOutputTimedOut,
      });
    };
    child.on("close", (code, signal) => {
      if (
        process.platform !== "win32" ||
        childExitState != null ||
        code != null ||
        signal != null ||
        child.exitCode != null ||
        child.signalCode != null
      ) {
        resolveFromClose(code, signal);
        return;
      }

      const startedAt = Date.now();
      const waitForExitState = () => {
        if (settled) {
          return;
        }
        if (childExitState != null || child.exitCode != null || child.signalCode != null) {
          resolveFromClose(code, signal);
          return;
        }
        if (Date.now() - startedAt >= WINDOWS_CLOSE_STATE_SETTLE_TIMEOUT_MS) {
          resolveFromClose(code, signal);
          return;
        }
        setTimeout(waitForExitState, WINDOWS_CLOSE_STATE_POLL_MS);
      };
      waitForExitState();
    });
  });
}
