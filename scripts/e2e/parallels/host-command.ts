// Host Command script supports OpenClaw repository automation.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addTimerTimeoutGraceMs,
  clampTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { terminateManagedChild } from "../../lib/managed-child-process.mts";
import { resolveNpmRunner } from "../../npm-runner.mts";
import { resolvePnpmRunner } from "../../pnpm-runner.mts";
import { buildCmdExeCommandLine, resolveWindowsCmdExePath } from "../../windows-cmd-helpers.mjs";
import type { CommandResult, RunOptions } from "./types.ts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const HOST_COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const HOST_COMMAND_WRAPPER_EXTRA_BUFFER_BYTES = 1024 * 1024;
const HOST_COMMAND_WRAPPER_BACKSTOP_MS = 5_000;
const HOST_COMMAND_TIMEOUT_KILL_GRACE_MS = 100;
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
  let processGroupError: NodeJS.ErrnoException | undefined;
  terminateManagedChild(
    {
      kill: (childSignal) => process.kill(pid, childSignal),
      pid,
    },
    signal,
    {
      onChildSignalError(error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          return;
        }
        const reason = processGroupError
          ? `group ${processGroupError.code ?? processGroupError.toString()}, leader ${code ?? String(error)}`
          : (code ?? String(error));
        warn(`failed to send ${signal} to host command process ${pid}: ${reason}`);
      },
      onProcessGroupSignalError(error) {
        processGroupError = error as NodeJS.ErrnoException;
      },
      processGroupFallback: "nonmissing",
      useWindowsTaskkill: false,
    },
  );
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
let killDeadlineAt = 0;
let timedOutCleanupStarted = false;
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
    return;
  } catch (error) {
    if (error && error.code === "ESRCH") {
      return;
    }
    try {
      process.kill(child.pid, signal);
    } catch (fallbackError) {
      if (!fallbackError || fallbackError.code !== "ESRCH") {
        process.stderr.write("failed to send " + signal + " to host command process " + child.pid + ": group " + ((error && error.code) || String(error)) + ", leader " + ((fallbackError && fallbackError.code) || String(fallbackError)) + "\n");
      }
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
    if (!error || error.code !== "EPERM") {
      return false;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

function finishTimedOut() {
  writeSync(3, ${JSON.stringify(HOST_COMMAND_TIMEOUT_PREFIX)} + "{}\n");
  process.exit(124);
}

function finishTimedOutAfterCleanup() {
  if (timedOutCleanupStarted) {
    return;
  }
  timedOutCleanupStarted = true;
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
  finishTimedOutAfterCleanup();
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
