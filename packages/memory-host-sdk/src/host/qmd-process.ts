// Memory Host SDK module implements qmd process behavior.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolveSafeTimeoutDelayMs } from "../../../gateway-client/src/timeouts.js";
import { materializeWindowsSpawnProgram, resolveWindowsSpawnProgram } from "./windows-spawn.js";

export type CliSpawnInvocation = {
  command: string;
  argv: string[];
  shell?: boolean;
  windowsHide?: boolean;
};

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
    });
    const timeoutMs = resolveSafeTimeoutDelayMs(params.timeoutMs ?? 2_000, { minMs: 0 });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
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
      child.kill();
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

export async function runCliCommand(params: {
  commandSummary: string;
  spawnInvocation: CliSpawnInvocation;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars: number;
  discardStdout?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.spawnInvocation.command, params.spawnInvocation.argv, {
      env: params.env,
      cwd: params.cwd,
      shell: params.spawnInvocation.shell,
      windowsHide: params.spawnInvocation.windowsHide,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const discardStdout = params.discardStdout === true;
    const timeoutMs =
      params.timeoutMs === undefined ? undefined : resolveSafeTimeoutDelayMs(params.timeoutMs);
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${params.commandSummary} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;
    child.stdout.on("data", (data) => {
      if (discardStdout) {
        return;
      }
      const next = appendOutputWithCap(stdout, data.toString("utf8"), params.maxOutputChars);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (data) => {
      const next = appendOutputWithCap(stderr, data.toString("utf8"), params.maxOutputChars);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
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
            signal: signal ?? null,
            stdout,
            stderr,
          }),
        );
      }
    });
  });
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
