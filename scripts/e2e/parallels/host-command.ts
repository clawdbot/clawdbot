// Host Command script supports OpenClaw repository automation.
import { spawn, spawnSync, type SpawnOptions, type SpawnSyncReturns } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  addTimerTimeoutGraceMs,
  clampTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { resolveNpmRunner } from "../../npm-runner.mjs";
import { resolvePnpmRunner } from "../../pnpm-runner.mjs";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../../windows-cmd-helpers.mjs";
import type { CommandResult, RunOptions } from "./types.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const HOST_COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const HOST_COMMAND_WRAPPER_EXTRA_BUFFER_BYTES = 1024 * 1024;
const HOST_COMMAND_WRAPPER_BACKSTOP_MS = 5_000;
const HOST_COMMAND_TIMEOUT_KILL_GRACE_MS = 100;
const HOST_COMMAND_STREAMING_TIMEOUT_KILL_GRACE_MS = 2_000;
const HOST_COMMAND_PROCESS_GROUP_EXIT_POLL_MS = 25;
const HOST_COMMAND_POST_FORCE_KILL_WAIT_MS = 100;
const HOST_COMMAND_CHILD_PID_PREFIX = "__OPENCLAW_HOST_COMMAND_CHILD_PID__";
const HOST_COMMAND_SPAWN_ERROR_PREFIX = "__OPENCLAW_HOST_COMMAND_SPAWN_ERROR__";
const HOST_COMMAND_TIMEOUT_PREFIX = "__OPENCLAW_HOST_COMMAND_TIMEOUT__";
let progressStderrDepth = 0;

type HostCommandInvocation = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
};

type ResolveHostCommandOptions = {
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (path: string) => boolean;
  platform?: NodeJS.Platform;
};

function hostInvocationFromRunner(runner: HostCommandInvocation): HostCommandInvocation {
  if (runner.env === undefined) {
    const invocation = { ...runner };
    delete invocation.env;
    return invocation;
  }
  return runner;
}

export function say(message: string): void {
  const stream = progressStderrDepth > 0 ? process.stderr : process.stdout;
  stream.write(`==> ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warn: ${message}\n`);
}

export async function withProgressOnStderr<T>(fn: () => Promise<T>): Promise<T> {
  progressStderrDepth++;
  try {
    return await fn();
  } finally {
    progressStderrDepth--;
  }
}

export function die(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function signalHostCommandProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      warn(
        `failed to send ${signal} to timed host command process ${pid}: ${code ?? String(error)}`,
      );
    }
  }
}

const POSIX_TIMEOUT_WRAPPER = String.raw`
const { spawn } = require("node:child_process");
const { readFileSync, writeSync } = require("node:fs");

const payload = JSON.parse(readFileSync(0, "utf8"));
const child = spawn(payload.command, payload.args, {
  cwd: payload.cwd,
  detached: true,
  env: payload.env,
  shell: payload.shell,
  stdio: ["pipe", "pipe", "pipe"],
});
writeSync(
  3,
  ${JSON.stringify(HOST_COMMAND_CHILD_PID_PREFIX)} + JSON.stringify({
    pid: child.pid || null,
  }) + "\n",
);

let timedOut = false;
let killTimer;
let killDeadlineAt = 0;
let outputExceeded = false;
let forwardedSignal;
let forwardedSignalKillTimer;
let forwardedSignalPostForceTimer;
let stderrBytes = 0;
let stdoutBytes = 0;

function writeAllSync(fd, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    offset += writeSync(fd, chunk, offset, chunk.byteLength - offset);
  }
}

function signalGroup(signal) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && error.code !== "ESRCH") {
      process.stderr.write("failed to send " + signal + " to timed host command process " + child.pid + ": " + (error.code || String(error)) + "\n");
    }
  }
}

function groupAlive() {
  if (!child.pid) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function finishTimedOut() {
  if (killTimer) {
    clearTimeout(killTimer);
  }
  writeSync(3, ${JSON.stringify(HOST_COMMAND_TIMEOUT_PREFIX)} + "{}\n");
  process.exit(124);
}

function finishTimedOutAfterCleanup() {
  if (!groupAlive()) {
    finishTimedOut();
    return;
  }
  const pollMs = Math.max(1, Math.min(25, payload.timeoutKillGraceMs));
  let pollTimer;
  let forceFinishTimer;
  let postForceFinishTimer;
  const finish = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    if (forceFinishTimer) {
      clearTimeout(forceFinishTimer);
    }
    if (postForceFinishTimer) {
      clearTimeout(postForceFinishTimer);
    }
    finishTimedOut();
  };
  pollTimer = setInterval(() => {
    if (!groupAlive()) {
      finish();
    }
  }, pollMs);
  forceFinishTimer = setTimeout(() => {
    signalGroup("SIGKILL");
    postForceFinishTimer = setTimeout(finish, pollMs);
  }, Math.max(0, killDeadlineAt - Date.now()));
}

function finishForwardedSignal() {
  if (!forwardedSignal) {
    return;
  }
  if (forwardedSignalKillTimer) {
    clearTimeout(forwardedSignalKillTimer);
  }
  if (forwardedSignalPostForceTimer) {
    clearTimeout(forwardedSignalPostForceTimer);
  }
  process.kill(process.pid, forwardedSignal);
}

function finishForwardedSignalAfterCleanup() {
  if (!forwardedSignal) {
    return;
  }
  if (!groupAlive()) {
    finishForwardedSignal();
    return;
  }
  if (forwardedSignalKillTimer) {
    return;
  }
  forwardedSignalKillTimer = setTimeout(() => {
    if (groupAlive()) {
      signalGroup("SIGKILL");
      forwardedSignalPostForceTimer = setTimeout(
        finishForwardedSignal,
        Math.max(1, Math.min(25, payload.timeoutKillGraceMs)),
      );
    } else {
      finishForwardedSignal();
    }
  }, payload.timeoutKillGraceMs);
}

function forwardBounded(stream, chunk) {
  const currentBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
  const nextBytes = currentBytes + chunk.byteLength;
  const limit = payload.maxBufferBytes;
  if (stream === "stdout") {
    stdoutBytes = nextBytes;
  } else {
    stderrBytes = nextBytes;
  }
  if (outputExceeded) {
    return;
  }
  if (nextBytes <= limit) {
    writeAllSync(stream === "stdout" ? 1 : 2, chunk);
    return;
  }
  outputExceeded = true;
  const allowedBytes = Math.max(0, limit - currentBytes);
  if (allowedBytes > 0) {
    writeAllSync(stream === "stdout" ? 1 : 2, chunk.subarray(0, allowedBytes));
  }
  writeAllSync(
    2,
    Buffer.from("host command output exceeded " + limit + " bytes; terminating process group\n"),
  );
  signalGroup("SIGKILL");
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    forwardedSignal ||= signal;
    signalGroup(signal);
    finishForwardedSignalAfterCleanup();
  });
}

const timeout = setTimeout(() => {
  timedOut = true;
  signalGroup("SIGTERM");
  killDeadlineAt = Date.now() + payload.timeoutKillGraceMs;
  killTimer = setTimeout(() => signalGroup("SIGKILL"), payload.timeoutKillGraceMs);
  killTimer.unref();
}, payload.timeoutMs);
timeout.unref();

child.stdout.on("data", (chunk) => forwardBounded("stdout", chunk));
child.stderr.on("data", (chunk) => forwardBounded("stderr", chunk));
child.stdin.on("error", (error) => {
  if (error && error.code !== "EPIPE" && error.code !== "ECONNRESET") {
    writeAllSync(2, Buffer.from("host command stdin write failed: " + (error.code || String(error)) + "\n"));
  }
});
child.on("error", (error) => {
  clearTimeout(timeout);
  if (killTimer) {
    clearTimeout(killTimer);
  }
  writeSync(
    3,
    ${JSON.stringify(HOST_COMMAND_SPAWN_ERROR_PREFIX)} + JSON.stringify({
      code: error.code || null,
      message: error.message,
    }) + "\n",
  );
  process.stderr.write(error.message + "\n");
  process.exit(127);
});
child.on("close", (code, signal) => {
  clearTimeout(timeout);
  if (forwardedSignal) {
    finishForwardedSignalAfterCleanup();
    return;
  }
  if (timedOut) {
    finishTimedOutAfterCleanup();
    return;
  }
  if (killTimer) {
    clearTimeout(killTimer);
  }
  if (outputExceeded) {
    process.exit(1);
  }
  process.exit(code ?? (signal ? 128 : 1));
});

if (payload.input != null) {
  child.stdin.end(payload.input);
} else {
  child.stdin.end();
}
`;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function portableBasename(value: string): string {
  return value.split(/[/\\]/u).at(-1) ?? value;
}

function portableExtension(value: string): string {
  return path.posix.extname(portableBasename(value)).toLowerCase();
}

function isBareCommand(command: string, name: "npm" | "pnpm"): boolean {
  return portableBasename(command) === command && command.toLowerCase() === name;
}

function resolveHostCommandTimeoutMs(timeoutMs: number): number {
  return clampTimerTimeoutMs(timeoutMs) ?? 1;
}

function resolveOptionalHostCommandTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : resolveHostCommandTimeoutMs(timeoutMs);
}

export function resolveHostCommandInvocation(
  command: string,
  args: string[],
  options: ResolveHostCommandOptions = {},
): HostCommandInvocation {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const comSpec = options.comSpec ?? resolveWindowsCmdExePath(env);

  if (isBareCommand(command, "pnpm")) {
    const runner = resolvePnpmRunner({
      comSpec,
      env,
      npmExecPath: env.npm_execpath,
      nodeExecPath: options.execPath ?? process.execPath,
      platform,
      pnpmArgs: args,
    });
    return hostInvocationFromRunner(runner);
  }

  if (isBareCommand(command, "npm")) {
    const runner = resolveNpmRunner({
      comSpec,
      env,
      execPath: options.execPath ?? process.execPath,
      existsSync: options.existsSync,
      npmArgs: args,
      platform,
    });
    return hostInvocationFromRunner(runner);
  }

  const extension = portableExtension(command);
  if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    return {
      args: ["/d", "/s", "/c", buildCmdExeCommandLine(command, args)],
      command: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    };
  }

  return { args, command, shell: false };
}

export function run(command: string, args: string[], options: RunOptions = {}): CommandResult {
  const env = { ...process.env, ...options.env };
  const invocation = resolveHostCommandInvocation(command, args, { env });
  const timeoutMs = resolveOptionalHostCommandTimeoutMs(options.timeoutMs);
  const usesPosixTimedWrapper = process.platform !== "win32" && timeoutMs !== undefined;
  const result = usesPosixTimedWrapper
    ? runPosixTimedCommandSync(invocation, env, options, timeoutMs)
    : spawnSync(invocation.command, invocation.args, {
        cwd: options.cwd ?? repoRoot,
        encoding: "utf8",
        env: invocation.env ?? env,
        input: options.input,
        killSignal: "SIGKILL",
        maxBuffer: HOST_COMMAND_MAX_BUFFER_BYTES,
        stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
        timeout: timeoutMs,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

  let wrapperTimedOut = false;
  if (usesPosixTimedWrapper) {
    const wrapperControl = typeof result.output[3] === "string" ? result.output[3] : "";
    const outerWrapperTimedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (outerWrapperTimedOut) {
      signalHostCommandProcess(parsePosixTimedWrapperChildPid(wrapperControl), "SIGKILL");
    }
    wrapperTimedOut = outerWrapperTimedOut || hasPosixTimedWrapperTimeout(wrapperControl);
    const spawnError = parsePosixTimedWrapperSpawnError(wrapperControl);
    if (spawnError) {
      throw spawnError;
    }
  }
  const timedOut =
    wrapperTimedOut || (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (wrapperTimedOut && options.check !== false) {
    const error = new Error(
      `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
    ) as NodeJS.ErrnoException;
    error.code = "ETIMEDOUT";
    throw error;
  }
  if (result.error && !(timedOut && options.check === false)) {
    throw result.error;
  }

  const status = timedOut ? 124 : (result.status ?? (result.signal ? 128 : 1));
  const commandResult = {
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    status,
  };
  if (options.check !== false && status !== 0) {
    if (commandResult.stdout) {
      process.stdout.write(commandResult.stdout);
    }
    if (commandResult.stderr) {
      process.stderr.write(commandResult.stderr);
    }
    die(`command failed (${status}): ${[command, ...args].join(" ")}`);
  }
  return commandResult;
}

function hasPosixTimedWrapperTimeout(controlOutput: string): boolean {
  return controlOutput.split("\n").some((entry) => entry.startsWith(HOST_COMMAND_TIMEOUT_PREFIX));
}

function parsePosixTimedWrapperChildPid(controlOutput: string): number | undefined {
  const line = controlOutput
    .split("\n")
    .find((entry) => entry.startsWith(HOST_COMMAND_CHILD_PID_PREFIX));
  if (!line) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line.slice(HOST_COMMAND_CHILD_PID_PREFIX.length)) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function parsePosixTimedWrapperSpawnError(stderr: string): NodeJS.ErrnoException | null {
  const line = stderr
    .split("\n")
    .find((entry) => entry.startsWith(HOST_COMMAND_SPAWN_ERROR_PREFIX));
  if (!line) {
    return null;
  }
  const raw = line.slice(HOST_COMMAND_SPAWN_ERROR_PREFIX.length);
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    const error = new Error(
      typeof parsed.message === "string" ? parsed.message : "host command spawn failed",
    ) as NodeJS.ErrnoException;
    if (typeof parsed.code === "string") {
      error.code = parsed.code;
    }
    return error;
  } catch {
    return new Error("host command spawn failed") as NodeJS.ErrnoException;
  }
}

function runPosixTimedCommandSync(
  invocation: HostCommandInvocation,
  env: NodeJS.ProcessEnv,
  options: RunOptions,
  timeoutMs: number,
): SpawnSyncReturns<string> {
  const wrapperTimeoutMs = addTimerTimeoutGraceMs(timeoutMs, HOST_COMMAND_WRAPPER_BACKSTOP_MS) ?? 1;
  const payload = JSON.stringify({
    args: invocation.args,
    command: invocation.command,
    cwd: options.cwd ?? repoRoot,
    env: invocation.env ?? env,
    input: options.input,
    maxBufferBytes: HOST_COMMAND_MAX_BUFFER_BYTES,
    shell: invocation.shell,
    timeoutKillGraceMs: HOST_COMMAND_TIMEOUT_KILL_GRACE_MS,
    timeoutMs,
  });
  return spawnSync(process.execPath, ["-e", POSIX_TIMEOUT_WRAPPER], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env,
    input: payload,
    killSignal: "SIGKILL",
    maxBuffer: HOST_COMMAND_MAX_BUFFER_BYTES * 2 + HOST_COMMAND_WRAPPER_EXTRA_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    timeout: wrapperTimeoutMs,
  });
}

export function sh(script: string, options: RunOptions = {}): CommandResult {
  return run("bash", ["-lc", script], options);
}

export async function runStreaming(
  command: string,
  args: string[],
  options: RunOptions & { logPath?: string } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const env = { ...process.env, ...options.env };
    const invocation = resolveHostCommandInvocation(command, args, { env });
    const timeoutMs = resolveOptionalHostCommandTimeoutMs(options.timeoutMs);
    const logStream = options.logPath
      ? createWriteStream(options.logPath, { encoding: "utf8", flags: "w" })
      : undefined;
    let logStreamError: Error | undefined;
    const detached = process.platform !== "win32" && timeoutMs !== undefined;
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? repoRoot,
      detached,
      env: invocation.env ?? env,
      shell: invocation.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    } satisfies SpawnOptions);
    const childPid = child.pid;
    const signalStreamingChild = (signal: NodeJS.Signals): void => {
      if (detached) {
        signalHostCommandProcess(childPid, signal);
        return;
      }
      try {
        child.kill(signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          warn(`failed to send ${signal} to host command process: ${code ?? String(error)}`);
        }
      }
    };
    const streamingProcessGroupAlive = (): boolean => {
      if (!detached || !childPid) {
        return false;
      }
      try {
        process.kill(-childPid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const waitForStreamingProcessGroupExit = async (timeoutBudgetMs: number): Promise<boolean> => {
      const deadlineAt = Date.now() + timeoutBudgetMs;
      while (Date.now() < deadlineAt) {
        if (!streamingProcessGroupAlive()) {
          return true;
        }
        await new Promise((resolvePoll) => {
          setTimeout(resolvePoll, HOST_COMMAND_PROCESS_GROUP_EXIT_POLL_MS);
        });
      }
      return !streamingProcessGroupAlive();
    };
    logStream?.on("error", (error) => {
      logStreamError = error;
      signalStreamingChild("SIGTERM");
    });
    const parentSignalHandlers = new Map<NodeJS.Signals, () => void>();
    let forwardedParentSignal: NodeJS.Signals | undefined;
    let parentSignalKillTimer: NodeJS.Timeout | undefined;
    let parentSignalPostForceTimer: NodeJS.Timeout | undefined;
    const removeParentSignalHandlers = (): void => {
      for (const [signal, handler] of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.clear();
    };
    const clearParentSignalTimers = (): void => {
      if (parentSignalKillTimer) {
        clearTimeout(parentSignalKillTimer);
        parentSignalKillTimer = undefined;
      }
      if (parentSignalPostForceTimer) {
        clearTimeout(parentSignalPostForceTimer);
        parentSignalPostForceTimer = undefined;
      }
    };
    const finishParentSignal = (): void => {
      if (!forwardedParentSignal) {
        return;
      }
      clearParentSignalTimers();
      removeParentSignalHandlers();
      process.kill(process.pid, forwardedParentSignal);
    };
    const finishParentSignalAfterCleanup = (): void => {
      if (!forwardedParentSignal) {
        return;
      }
      if (!streamingProcessGroupAlive()) {
        finishParentSignal();
        return;
      }
      if (parentSignalKillTimer) {
        return;
      }
      parentSignalKillTimer = setTimeout(() => {
        if (streamingProcessGroupAlive()) {
          signalHostCommandProcess(childPid, "SIGKILL");
          parentSignalPostForceTimer = setTimeout(
            finishParentSignal,
            HOST_COMMAND_POST_FORCE_KILL_WAIT_MS,
          );
        } else {
          finishParentSignal();
        }
      }, HOST_COMMAND_TIMEOUT_KILL_GRACE_MS);
    };
    if (process.platform !== "win32" && timeoutMs !== undefined) {
      for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
        const handler = (): void => {
          forwardedParentSignal ??= signal;
          signalHostCommandProcess(childPid, signal);
          removeParentSignalHandlers();
          finishParentSignalAfterCleanup();
        };
        parentSignalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
    }

    const writeLogChunk = (chunk: Buffer): void => {
      if (!logStream || logStream.destroyed) {
        return;
      }
      if (!logStream.write(chunk)) {
        child.stdout?.pause();
        child.stderr?.pause();
        logStream.once("drain", () => {
          child.stdout?.resume();
          child.stderr?.resume();
        });
      }
    };
    const append = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      writeLogChunk(chunk);
      if (!options.quiet) {
        process.stdout.write(text);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      writeLogChunk(chunk);
      if (!options.quiet) {
        process.stderr.write(text);
      }
    });
    if (options.input != null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let killDeadlineAt = 0;
    const waitForStreamingTimeoutCleanup = async (): Promise<void> => {
      if (!detached) {
        signalStreamingChild("SIGKILL");
        return;
      }
      const remainingGraceMs = Math.max(0, killDeadlineAt - Date.now());
      if (remainingGraceMs > 0) {
        await waitForStreamingProcessGroupExit(remainingGraceMs);
      }
      if (streamingProcessGroupAlive()) {
        signalStreamingChild("SIGKILL");
        await waitForStreamingProcessGroupExit(HOST_COMMAND_POST_FORCE_KILL_WAIT_MS);
      }
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            signalHostCommandProcess(childPid, "SIGTERM");
            killDeadlineAt = Date.now() + HOST_COMMAND_STREAMING_TIMEOUT_KILL_GRACE_MS;
            killTimer = setTimeout(
              () => signalHostCommandProcess(childPid, "SIGKILL"),
              HOST_COMMAND_STREAMING_TIMEOUT_KILL_GRACE_MS,
            );
            killTimer.unref();
          }, timeoutMs);

    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      clearParentSignalTimers();
      removeParentSignalHandlers();
      logStream?.destroy();
      reject(error);
    });
    child.on("close", (code, signal) => {
      void (async () => {
        if (timer) {
          clearTimeout(timer);
        }
        if (forwardedParentSignal) {
          finishParentSignalAfterCleanup();
          return;
        }
        removeParentSignalHandlers();
        if (timedOut) {
          await waitForStreamingTimeoutCleanup();
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        clearParentSignalTimers();
        if (logStream) {
          logStream.end();
          await finished(logStream);
        }
        if (logStreamError) {
          throw logStreamError;
        }
        if (timedOut) {
          resolve(124);
        } else {
          resolve(code ?? (signal ? 128 : 1));
        }
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        reject(
          new Error(`failed to write Parallels host command log: ${message}`, { cause: error }),
        );
      });
    });
  });
}
