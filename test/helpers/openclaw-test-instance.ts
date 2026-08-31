// OpenClaw test instance helper spawns isolated OpenClaw processes.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mts";
import { terminateManagedChild } from "../../scripts/lib/managed-child-process.mts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { sleep } from "../../src/utils.js";

type OpenClawTestStateOptions = NonNullable<Parameters<typeof createOpenClawTestState>[0]>;

type OpenClawTestInstanceOptions = {
  name: string;
  cwd?: string;
  port?: number;
  gatewayToken?: string;
  hookToken?: string;
  config?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  state?: Omit<OpenClawTestStateOptions, "applyEnv" | "gateway" | "env">;
  gatewayArgs?: string[];
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
};

type OpenClawTestInstanceCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type OpenClawTestProcess = ChildProcessByStdio<null, Readable, Readable>;

export type OpenClawTestInstance = {
  name: string;
  port: number;
  url: string;
  hookToken: string;
  gatewayToken: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  state: OpenClawTestState;
  stdout: string[];
  stderr: string[];
  child?: OpenClawTestProcess;
  env: NodeJS.ProcessEnv;
  entrypoint: () => Promise<string[]>;
  cli: (
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<OpenClawTestInstanceCommandResult>;
  startGateway: () => Promise<void>;
  stopGateway: () => Promise<void>;
  logs: () => string;
  cleanup: () => Promise<void>;
};

const GATEWAY_START_TIMEOUT_MS = 60_000;
const GATEWAY_STOP_TIMEOUT_MS = 1_500;
const GATEWAY_ENTRYPOINT_PREPARE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 30_000;
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const GATEWAY_MIGRATION_CONVERGENCE_MAX_RESTARTS = 1;
const GATEWAY_MIGRATION_CONVERGENCE_REFUSAL_PREFIX =
  "OpenClaw plugin migration inputs changed during startup convergence;";
const GATEWAY_MIGRATION_CONVERGENCE_RESTART_MARKER =
  "[openclaw-test-instance] restarting gateway after migration convergence refusal\n";
const entrypointPromises = new Map<string, Promise<string[]>>();

type BoundedStringLog = string[] & {
  byteLength?: number;
  truncated?: boolean;
};

type OpenClawTestChildProcess = Pick<OpenClawTestProcess, "kill" | "pid">;
type OpenClawTestProcessReadiness = Pick<OpenClawTestProcess, "exitCode" | "signalCode"> & {
  once: (event: "exit", listener: () => void) => unknown;
  off: (event: "exit", listener: () => void) => unknown;
};
type GatewayProcessStopOptions = NonNullable<Parameters<typeof terminateManagedChild>[2]> & {
  forceWindowsTree?: boolean;
};

function createBoundedStringLog(): string[] {
  const log = [] as BoundedStringLog;
  log.byteLength = 0;
  log.truncated = false;
  return log;
}

function appendLogChunk(log: string[], chunk: unknown, maxBytes = LOG_TAIL_MAX_BYTES): void {
  const chunks = log as BoundedStringLog;
  const limit = Math.max(1, maxBytes);
  const text = String(chunk);
  const textBytes = Buffer.byteLength(text);
  if (textBytes >= limit) {
    const buffer = Buffer.from(text);
    const tail = buffer.subarray(buffer.length - limit).toString("utf8");
    chunks.splice(0, chunks.length, tail);
    chunks.byteLength = Buffer.byteLength(tail);
    chunks.truncated = true;
    return;
  }

  chunks.push(text);
  chunks.byteLength = (chunks.byteLength ?? 0) + textBytes;
  while ((chunks.byteLength ?? 0) > limit && chunks.length > 0) {
    const first = chunks[0] ?? "";
    const firstBytes = Buffer.byteLength(first);
    const overflow = (chunks.byteLength ?? 0) - limit;
    if (firstBytes <= overflow) {
      chunks.shift();
      chunks.byteLength = (chunks.byteLength ?? 0) - firstBytes;
      chunks.truncated = true;
      continue;
    }

    const buffer = Buffer.from(first);
    const tail = buffer.subarray(overflow).toString("utf8");
    chunks[0] = tail;
    chunks.byteLength = chunks.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
    chunks.truncated = true;
  }
}

function readLogBuffer(log: string[]): string {
  const text = log.join("");
  return (log as BoundedStringLog).truncated
    ? `[output truncated to last ${LOG_TAIL_MAX_BYTES} bytes]\n${text}`
    : text;
}

function isGatewayMigrationConvergenceRefusal(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): boolean {
  return (
    code === 1 &&
    signal === null &&
    stderr
      .split(/\r?\n/u)
      .some((line) => line.startsWith(GATEWAY_MIGRATION_CONVERGENCE_REFUSAL_PREFIX))
  );
}

async function resolveBuiltGatewayEntrypoint(cwd: string): Promise<string[] | null> {
  const buildStampPath = path.join(cwd, "dist", BUILD_STAMP_FILE);
  const runtimePostBuildStampPath = path.join(cwd, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
  for (const entrypoint of ["dist/index.js", "dist/index.mjs"]) {
    try {
      await Promise.all([
        fs.access(path.join(cwd, entrypoint)),
        fs.access(buildStampPath),
        fs.access(runtimePostBuildStampPath),
      ]);
      return [entrypoint];
    } catch {
      // try the next built entrypoint
    }
  }
  return null;
}

async function prepareGatewayEntrypoint(cwd: string): Promise<string[]> {
  const builtEntrypoint = await resolveBuiltGatewayEntrypoint(cwd);
  if (builtEntrypoint) {
    return builtEntrypoint;
  }

  const stdout = createBoundedStringLog();
  const stderr = createBoundedStringLog();
  const child = spawn("node", ["scripts/run-node.mjs", "--help"], {
    cwd,
    env: { ...process.env, VITEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: shouldUseOpenClawTestProcessGroup(),
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => appendLogChunk(stdout, d));
  child.stderr?.on("data", (d) => appendLogChunk(stderr, d));

  const completed = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    sleep(GATEWAY_ENTRYPOINT_PREPARE_TIMEOUT_MS).then(() => null),
  ]);

  if (completed === null) {
    signalOpenClawTestProcess(child, "SIGKILL");
    throw new Error(`timeout preparing gateway entrypoint\n${formatLogs(stdout, stderr)}`);
  }
  if (completed.code !== 0) {
    throw new Error(
      `failed preparing gateway entrypoint (code=${String(completed.code)} signal=${String(
        completed.signal,
      )})\n${formatLogs(stdout, stderr)}`,
    );
  }

  return (await resolveBuiltGatewayEntrypoint(cwd)) ?? ["scripts/run-node.mjs"];
}

async function resolveGatewayEntrypoint(cwd: string): Promise<string[]> {
  let promise = entrypointPromises.get(cwd);
  if (!promise) {
    promise = prepareGatewayEntrypoint(cwd);
    entrypointPromises.set(cwd, promise);
  }
  return await promise;
}

const getFreePort = async () => {
  const srv = net.createServer();
  await new Promise<void>((resolve) => {
    srv.listen(0, "127.0.0.1", resolve);
  });
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
  return addr.port;
};

async function waitForGatewayReady(
  proc: OpenClawTestProcessReadiness,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
) {
  const exitedBeforeReadinessError = () =>
    new Error(
      `gateway exited before readiness (code=${String(proc.exitCode)} signal=${String(
        proc.signalCode,
      )})\n${formatLogs(chunksOut, chunksErr)}`,
    );
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasChildExited(proc)) {
      throw exitedBeforeReadinessError();
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    const attemptTimeoutMs = Math.min(1_000, Math.max(1, remainingMs));
    const probeAbort = new AbortController();
    let attemptTimeout: ReturnType<typeof setTimeout> | undefined;
    let handleExit = () => {};
    const exitPromise = new Promise<never>((_resolve, reject) => {
      handleExit = () => {
        const error = exitedBeforeReadinessError();
        probeAbort.abort(error);
        reject(error);
      };
      proc.once("exit", handleExit);
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      attemptTimeout = setTimeout(() => {
        const error = new Error("gateway readiness probe timed out");
        probeAbort.abort(error);
        reject(error);
      }, attemptTimeoutMs);
      attemptTimeout.unref?.();
    });
    try {
      // A dead child cannot complete readiness. Race the owner lifecycle against
      // both HTTP headers and body parsing so a stuck probe never hides its exit.
      const ready = await Promise.race([
        (async () => {
          const response = await fetchImpl(`http://127.0.0.1:${port}/readyz`, {
            signal: probeAbort.signal,
          });
          const readiness: unknown = await response.json();
          return response.ok && isRecord(readiness) && readiness.ready === true;
        })(),
        exitPromise,
        timeoutPromise,
      ]);
      if (ready) {
        return;
      }
    } catch {
      if (hasChildExited(proc)) {
        throw exitedBeforeReadinessError();
      }
      // keep polling
    } finally {
      if (attemptTimeout) {
        clearTimeout(attemptTimeout);
      }
      proc.off("exit", handleExit);
    }

    const delayMs = Math.min(10, timeoutMs - (Date.now() - startedAt));
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
  throw new Error(
    `timeout waiting for gateway readiness on port ${port}\n${formatLogs(chunksOut, chunksErr)}`,
  );
}

function hasGatewayProcessClosed(child: OpenClawTestProcess): boolean {
  return hasChildExited(child) && child.stdout.closed && child.stderr.closed;
}

async function waitForGatewayClose(
  child: OpenClawTestProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!hasGatewayProcessClosed(child) && Date.now() < deadline) {
    await sleep(Math.min(10, deadline - Date.now()));
  }
  return hasGatewayProcessClosed(child);
}

async function stopGatewayProcess(
  child: OpenClawTestProcess,
  deadline: number,
  stopTimeoutMs: number,
  options: GatewayProcessStopOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const waitForClose = (remainingSteps: number) =>
    waitForGatewayClose(
      child,
      Math.min(
        stopTimeoutMs,
        Math.max(0, Math.floor((deadline - Date.now()) / Math.max(1, remainingSteps))),
      ),
    );
  const terminate = (signal: NodeJS.Signals) => {
    terminateManagedChild(
      child,
      signal,
      options.runTaskkill
        ? { platform, runTaskkill: options.runTaskkill }
        : {
            platform,
          },
    );
  };
  const forceWindowsTree = options.forceWindowsTree === true && platform === "win32";
  const signals = forceWindowsTree ? (["SIGKILL"] as const) : (["SIGTERM", "SIGKILL"] as const);

  if (hasGatewayProcessClosed(child)) {
    return true;
  }
  // An exited leader can leave inherited stdio open in descendants. Let it
  // settle briefly, then terminate the owned tree before releasing the slot.
  if (!forceWindowsTree && hasChildExited(child) && (await waitForClose(signals.length + 1))) {
    return true;
  }
  for (const [index, signal] of signals.entries()) {
    if (hasGatewayProcessClosed(child)) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    try {
      terminate(signal);
    } catch {
      // ignore
    }
    if (await waitForClose(signals.length - index)) {
      return true;
    }
  }
  return hasGatewayProcessClosed(child);
}

function hasChildExited(child: Pick<OpenClawTestProcess, "exitCode" | "signalCode">) {
  return child.exitCode !== null || child.signalCode !== null;
}

function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override) {
    return base;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    result[key] = isRecord(existing) && isRecord(value) ? mergeConfig(existing, value) : value;
  }
  return result;
}

function formatLogs(stdout: string[], stderr: string[]): string {
  return `--- stdout ---\n${readLogBuffer(stdout)}\n--- stderr ---\n${readLogBuffer(stderr)}`;
}

function createInstanceEnv(params: {
  stateEnv: NodeJS.ProcessEnv;
  extraEnv: Record<string, string | undefined>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...params.stateEnv,
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_GATEWAY_PASSWORD: "",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
    VITEST: "1",
  };
  for (const [key, value] of Object.entries(params.extraEnv)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

export async function createOpenClawTestInstance(
  options: OpenClawTestInstanceOptions,
): Promise<OpenClawTestInstance> {
  const cwd = options.cwd ?? process.cwd();
  const port = options.port ?? (await getFreePort());
  const gatewayToken = options.gatewayToken ?? `gateway-${options.name}-${randomUUID()}`;
  const hookToken = options.hookToken ?? `token-${options.name}-${randomUUID()}`;
  const state = await createOpenClawTestState({
    label: options.name,
    layout: "home",
    ...options.state,
    applyEnv: false,
    env: options.env,
  });
  try {
    await state.writeConfig(
      mergeConfig(
        {
          gateway: {
            port,
            auth: { mode: "token", token: gatewayToken },
            controlUi: { enabled: false },
          },
          hooks: { enabled: true, token: hookToken, path: "/hooks" },
        },
        options.config,
      ),
    );
  } catch (error) {
    // Config staging can fail before the instance exposes its cleanup handle.
    await state.cleanup();
    throw error;
  }

  const stdout = createBoundedStringLog();
  const stderr = createBoundedStringLog();
  const env = createInstanceEnv({
    stateEnv: state.env,
    extraEnv: options.env ?? {},
  });
  let child: { process: OpenClawTestProcess; ready: boolean } | undefined;
  let cleaned = false;
  let operation: { kind: "start" | "stop" | "cleanup"; promise: Promise<void> } | undefined;
  const enqueue = (kind: NonNullable<typeof operation>["kind"], action: () => Promise<void>) => {
    if (operation?.kind === kind) {
      return operation.promise;
    }
    // Claim ordering before preparation can yield. Teardown joins pending startup,
    // and another start cannot borrow readiness from a child being stopped.
    const next = {
      kind,
      promise: Promise.resolve(operation?.promise)
        .catch(() => undefined)
        .then(action),
    };
    operation = next;
    const release = () => {
      if (operation === next) {
        operation = undefined;
      }
    };
    void next.promise.then(release, release);
    return next.promise;
  };
  const stopTimeoutMs = options.stopTimeoutMs ?? GATEWAY_STOP_TIMEOUT_MS;
  const spawnGatewayProcess = (args: string[], attemptStderr: string[]): OpenClawTestProcess => {
    const next = spawn("node", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: shouldUseOpenClawTestProcessGroup(),
    });
    next.stdout.setEncoding("utf8");
    next.stderr.setEncoding("utf8");
    next.stdout.on("data", (chunk) => appendLogChunk(stdout, chunk));
    next.stderr.on("data", (chunk) => {
      appendLogChunk(stderr, chunk);
      appendLogChunk(attemptStderr, chunk);
    });
    return next;
  };
  const releaseGatewayChild = async (
    target: OpenClawTestProcess,
    deadline: number,
    stopOptions: GatewayProcessStopOptions = {},
  ): Promise<boolean> => {
    const closed = await stopGatewayProcess(target, deadline, stopTimeoutMs, stopOptions);
    if (closed && child?.process === target) {
      child = undefined;
    }
    return closed;
  };
  const stopGatewayChild = async (stopOptions: GatewayProcessStopOptions = {}) => {
    const target = child;
    if (!target) {
      return;
    }
    // A failed stop retains ownership, never the old readiness observation.
    target.ready = false;
    const closed = await releaseGatewayChild(
      target.process,
      Date.now() + stopTimeoutMs * 2,
      stopOptions,
    );
    if (!closed) {
      throw new Error(
        `gateway process did not close before stop deadline\n${formatLogs(stdout, stderr)}`,
      );
    }
  };

  const instance: OpenClawTestInstance = {
    name: options.name,
    port,
    url: `ws://127.0.0.1:${port}`,
    hookToken,
    gatewayToken,
    homeDir: state.home,
    stateDir: state.stateDir,
    configPath: state.configPath,
    state,
    stdout,
    stderr,
    get child() {
      return child?.process;
    },
    env,
    entrypoint: () => resolveGatewayEntrypoint(cwd),
    cli: async (args, commandOptions = {}) => {
      const entrypoint = await resolveGatewayEntrypoint(cwd);
      return await runCommand({
        args: ["node", ...entrypoint, ...args],
        cwd,
        env,
        timeoutMs: commandOptions.timeoutMs ?? COMMAND_TIMEOUT_MS,
      });
    },
    startGateway: () =>
      enqueue("start", async () => {
        if (cleaned) {
          throw new Error("cannot start a cleaned test instance");
        }
        if (child?.ready && !hasChildExited(child.process)) {
          return;
        }
        const entrypoint = await resolveGatewayEntrypoint(cwd);
        const gatewayArgs = [
          ...entrypoint,
          "gateway",
          "--port",
          String(port),
          "--bind",
          "loopback",
          "--allow-unconfigured",
          ...(options.gatewayArgs ?? []),
        ];
        await stopGatewayChild({ forceWindowsTree: true });
        const deadline = Date.now() + (options.startTimeoutMs ?? GATEWAY_START_TIMEOUT_MS);
        let restarts = 0;

        while (true) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw new Error(
              `timeout waiting for gateway readiness on port ${port}\n${formatLogs(stdout, stderr)}`,
            );
          }
          const attemptStderr = createBoundedStringLog();
          const attempt = spawnGatewayProcess(gatewayArgs, attemptStderr);
          const owner = { process: attempt, ready: false };
          child = owner;
          try {
            await waitForGatewayReady(attempt, stdout, stderr, port, remainingMs);
            owner.ready = true;
            return;
          } catch (err) {
            const exitCode = attempt.exitCode;
            const signalCode = attempt.signalCode;
            // Startup expiry stops retry admission, not ownership cleanup. Use the
            // same separate shutdown budget as explicit stop, retaining failed owners.
            const closed = await releaseGatewayChild(attempt, Date.now() + stopTimeoutMs * 2, {
              forceWindowsTree: true,
            });
            const shouldRestart =
              restarts < GATEWAY_MIGRATION_CONVERGENCE_MAX_RESTARTS &&
              isGatewayMigrationConvergenceRefusal(
                exitCode,
                signalCode,
                readLogBuffer(attemptStderr),
              );
            if (shouldRestart && closed && Date.now() < deadline) {
              restarts += 1;
              appendLogChunk(stderr, GATEWAY_MIGRATION_CONVERGENCE_RESTART_MARKER);
              continue;
            }
            throw err;
          }
        }
      }),
    stopGateway: () => enqueue("stop", stopGatewayChild),
    logs: () => formatLogs(stdout, stderr),
    cleanup: () =>
      enqueue("cleanup", async () => {
        if (cleaned) {
          return;
        }
        await stopGatewayChild();
        await state.cleanup();
        cleaned = true;
      }),
  };

  return instance;
}

async function runCommand(params: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<OpenClawTestInstanceCommandResult> {
  const [command, ...args] = params.args;
  if (!command) {
    throw new Error("missing command");
  }
  const stdout = createBoundedStringLog();
  const stderr = createBoundedStringLog();
  const child = spawn(command, args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: shouldUseOpenClawTestProcessGroup(),
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => appendLogChunk(stdout, d));
  child.stderr?.on("data", (d) => appendLogChunk(stderr, d));

  const completed = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    sleep(params.timeoutMs).then(() => null),
  ]);
  if (completed === null) {
    signalOpenClawTestProcess(child, "SIGKILL");
    await waitForGatewayClose(child, GATEWAY_STOP_TIMEOUT_MS);
    throw new Error(
      `command timed out after ${params.timeoutMs}ms: ${params.args.join(" ")}\n${formatLogs(stdout, stderr)}`,
    );
  }
  return {
    ...completed,
    stdout: readLogBuffer(stdout),
    stderr: readLogBuffer(stderr),
  };
}

function shouldUseOpenClawTestProcessGroup(): boolean {
  return process.platform !== "win32";
}

function signalOpenClawTestProcess(
  child: OpenClawTestChildProcess,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals) => boolean = (pid, nextSignal) =>
    process.kill(pid, nextSignal),
): void {
  if (shouldUseOpenClawTestProcessGroup() && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group already exited.
    }
  }
  child.kill(signal);
}

export const testing = {
  appendLogChunk,
  createBoundedStringLog,
  formatLogs,
  isGatewayMigrationConvergenceRefusal,
  signalOpenClawTestProcess,
  stopGatewayProcess,
  waitForGatewayReady,
};
