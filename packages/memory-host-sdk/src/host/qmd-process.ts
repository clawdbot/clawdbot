// Memory Host SDK module implements qmd process behavior.
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { resolveSafeTimeoutDelayMs } from "../../../gateway-client/src/timeouts.js";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

type QmdChildProcess = {
  pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
};

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

export type QmdBinaryUnavailableReason = "binary" | "workspace-cwd";

export type QmdBinaryUnavailable = {
  available: false;
  /**
   * Optional for source compatibility with older plugin SDK callers that
   * returned only `{ available: false, error }`.
   */
  reason?: QmdBinaryUnavailableReason;
  error: string;
};

export type QmdBinaryAvailability = { available: true } | QmdBinaryUnavailable;

export function resolveQmdBinaryUnavailableReason(
  result: QmdBinaryUnavailable,
): QmdBinaryUnavailableReason {
  return result.reason ?? "binary";
}

export function resolveCliSpawnInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  packageName: string;
}): CliSpawnInvocation {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: process.platform,
    env: params.env,
    execPath: process.execPath,
    packageName: params.packageName,
    allowShellFallback: false,
  });
  return materializeWindowsSpawnProgram(program, params.args);
}

export async function checkQmdBinaryAvailability(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<QmdBinaryAvailability> {
  let spawnInvocation: CliSpawnInvocation;
  try {
    spawnInvocation = resolveCliSpawnInvocation({
      command: params.command,
      args: [],
      env: params.env,
      packageName: "qmd",
    });
  } catch (err) {
    return { available: false, reason: "binary", error: formatQmdAvailabilityError(err) };
  }

  const cwd = params.cwd ?? process.cwd();
  const cwdError = validateQmdProbeCwd(cwd);
  if (cwdError) {
    return cwdError;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let didSpawn = false;
    const finish = (result: QmdBinaryAvailability) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(spawnInvocation.command, spawnInvocation.argv, {
      env: params.env,
      cwd,
      shell: spawnInvocation.shell,
      windowsHide: spawnInvocation.windowsHide,
      stdio: "ignore",
      detached: shouldUseQmdProcessGroup(),
    });
    const timeoutMs = resolveSafeTimeoutDelayMs(params.timeoutMs ?? 2_000, { minMs: 0 });
    const timer = setTimeout(() => {
      signalQmdProcessTree(child, "SIGKILL");
      finish({
        available: false,
        reason: "binary",
        error: `spawn ${params.command} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.once("error", (err) => {
      finish({ available: false, reason: "binary", error: formatQmdAvailabilityError(err) });
    });
    child.once("spawn", () => {
      didSpawn = true;
      signalQmdProcessTree(child);
      finish({ available: true });
    });
    child.once("close", () => {
      if (!didSpawn) {
        return;
      }
      finish({ available: true });
    });
  });
}

function validateQmdProbeCwd(cwd: string): QmdBinaryAvailability | null {
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) {
      return {
        available: false,
        reason: "workspace-cwd",
        error: `workspace directory is not a directory: ${cwd}`,
      };
    }
    return null;
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && err.code === "ENOENT") {
      return {
        available: false,
        reason: "workspace-cwd",
        error: `workspace directory missing: ${cwd}`,
      };
    }
    return {
      available: false,
      reason: "workspace-cwd",
      error: `workspace directory unavailable: ${cwd} (${formatQmdAvailabilityError(err)})`,
    };
  }
}

/**
 * Normalize an aborted signal into the error used to reject a killed command.
 * Prefers the caller-supplied abort reason (so a deadline message survives) and
 * falls back to a stable per-command abort error.
 */
function abortReason(signal: AbortSignal | undefined, commandSummary: string): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(`${commandSummary} aborted`);
}

export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
  /**
   * Caller-owned cancellation. When the signal aborts, the spawned child is
   * killed immediately and the call rejects, so a caller that already stopped
   * waiting (for example after its own deadline) does not leave an orphaned
   * process running for the full command timeout.
   */
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const { signal } = params;
    if (signal?.aborted) {
      reject(abortReason(signal, params.commandSummary));
      return;
    }
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
      detached: shouldUseQmdProcessGroup(),
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const discardStdout = params.discardStdout === true;
    // Let the streams carry partial UTF-8 sequences across pipe chunks before
    // qmd JSON, paths, or diagnostics reach the character-based output cap.
    if (!discardStdout) {
      child.stdout.setEncoding("utf8");
    }
    child.stderr.setEncoding("utf8");
    const timeoutMs =
      params.timeoutMs === undefined ? undefined : resolveSafeTimeoutDelayMs(params.timeoutMs);
    const timer = timeoutMs
      ? setTimeout(() => {
          signalQmdProcessTree(child, "SIGKILL");
          settle(() =>
            reject(new Error(`${params.commandSummary} timed out after ${timeoutMs}ms`)),
          );
        }, timeoutMs)
      : null;
    const onAbort = () => {
      signalQmdProcessTree(child, "SIGKILL");
      settle(() => reject(abortReason(signal, params.commandSummary)));
    };
    function settle(run: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      run();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (data: string) => {
      if (discardStdout) {
        return;
      }
      const next = appendOutputWithCap(stdout, data, params.maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (data: string) => {
      const next = appendOutputWithCap(stderr, data, params.maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    // Guard stdout/stderr against stream errors (e.g. EPIPE when the
    // child exits before all pipe data is consumed). Without listeners,
    // Node.js throws an uncaught exception that crashes the process.
    for (const streamName of ["stdout", "stderr"] as const) {
      child[streamName].on("error", (error: Error) => {
        if (settled) {
          return;
        }
        signalQmdProcessTree(child, "SIGKILL");
        settle(() =>
          reject(
            new Error(`${params.commandSummary} ${streamName} error: ${error.message}`, {
              cause: error,
            }),
          ),
        );
      });
    }

    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      settle(() => reject(err));
    });
    child.on("close", (code, closeSignal) => {
      if (timer) {
        clearTimeout(timer);
      }
      settle(() => {
        if (!discardStdout && (stdoutTruncated || stderrTruncated)) {
          reject(
            new Error(
              `${params.commandSummary} produced too much output (limit ${params.maxOutputChars} chars)`,
            ),
          );
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new CliCommandError({
              commandSummary: params.commandSummary,
              code,
              signal: closeSignal ?? null,
              stdout,
              stderr,
            }),
          );
        }
      });
    });
  });
}

function shouldUseQmdProcessGroup(): boolean {
  return process.platform !== "win32";
}

function getEnvValueCaseInsensitive(
  env: Record<string, string | undefined>,
  expectedKey: string,
): string | undefined {
  const direct = env[expectedKey];
  if (direct !== undefined) {
    return direct;
  }
  const expected = expectedKey.toUpperCase();
  const actualKey = Object.keys(env).find((key) => key.toUpperCase() === expected);
  return actualKey ? env[actualKey] : undefined;
}

function normalizeWindowsSystemRoot(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes(";")
  ) {
    return null;
  }
  const normalized = path.win32.normalize(trimmed);
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    return null;
  }
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root) || normalized.length <= parsed.root.length) {
    return null;
  }
  return normalized.replace(/[\\/]+$/, "");
}

function resolveWindowsTaskkillPath(env: Record<string, string | undefined> = process.env): string {
  const systemRoot =
    normalizeWindowsSystemRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsSystemRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT;
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function signalQmdProcessTree(child: QmdChildProcess, signal?: NodeJS.Signals): void {
  if (shouldUseQmdProcessGroup() && typeof child.pid === "number") {
    try {
      if (signal === undefined) {
        process.kill(-child.pid);
      } else {
        process.kill(-child.pid, signal);
      }
      return;
    } catch {
      // Fall back to the direct child if the process group already disappeared.
    }
  }
  if (!shouldUseQmdProcessGroup() && typeof child.pid === "number") {
    const taskkillPath = resolveWindowsTaskkillPath();
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const result = spawnSync(taskkillPath, args, { stdio: "ignore", windowsHide: true });
    if (!result.error && result.status === 0) {
      return;
    }
    if (signal !== "SIGKILL") {
      const forceResult = spawnSync(taskkillPath, [...args, "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (!forceResult.error && forceResult.status === 0) {
        return;
      }
    }
  }
  if (signal === undefined) {
    child.kill();
  } else {
    child.kill(signal);
  }
}

class CliCommandError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(params: {
    commandSummary: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }) {
    super(formatCliCommandFailureMessage(params));
    this.name = "CliCommandError";
    this.code = params.code;
    this.signal = params.signal;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
  }
}

function formatCliCommandFailureMessage(params: {
  commandSummary: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): string {
  const exit =
    params.code === null ? `signal ${params.signal ?? "unknown"}` : `code ${String(params.code)}`;
  return `${params.commandSummary} failed (${exit}): ${params.stderr || params.stdout}`;
}

function appendOutputWithCap(
  current: string,
  chunk: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const appended = current + chunk;
  const chars = Array.from(appended);
  if (chars.length <= maxChars) {
    return { text: appended, truncated: false };
  }
  return { text: chars.slice(-maxChars).join(""), truncated: true };
}

function formatQmdAvailabilityError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}
