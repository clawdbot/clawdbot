import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mjs";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  type OpenClawTestStateOptions,
} from "../../src/test-utils/openclaw-test-state.js";
import { sleep } from "../../src/utils.js";

export type OpenClawTestInstanceOptions = {
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

export type OpenClawTestInstanceCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

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
  child?: ChildProcessWithoutNullStreams;
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
const entrypointPromises = new Map<string, Promise<string[]>>();

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

  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn("node", ["scripts/run-node.mjs", "--help"], {
    cwd,
    env: { ...process.env, VITEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => stdout.push(String(d)));
  child.stderr?.on("data", (d) => stderr.push(String(d)));

  const completed = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    sleep(GATEWAY_ENTRYPOINT_PREPARE_TIMEOUT_MS).then(() => null),
  ]);

  if (completed === null) {
    child.kill("SIGKILL");
    throw new Error(
      `timeout preparing gateway entrypoint\n--- stdout ---\n${stdout.join("")}\n--- stderr ---\n${stderr.join("")}`,
    );
  }
  if (completed.code !== 0) {
    throw new Error(
      `failed preparing gateway entrypoint (code=${String(completed.code)} signal=${String(
        completed.signal,
      )})\n--- stdout ---\n${stdout.join("")}\n--- stderr ---\n${stderr.join("")}`,
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
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral port");
  }
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return addr.port;
};

async function waitForPortOpen(
  proc: ChildProcessWithoutNullStreams,
  chunksOut: string[],
  chunksErr: string[],
  port: number,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(
        `gateway exited before listening (code=${String(proc.exitCode)} signal=${String(
          proc.signalCode,
        )})\n${formatLogs(chunksOut, chunksErr)}`,
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      return;
    } catch {
      // keep polling
    }

    await sleep(10);
  }
  throw new Error(
    `timeout waiting for gateway to listen on port ${port}\n${formatLogs(chunksOut, chunksErr)}`,
  );
}

async function waitForGatewayExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return resolve(true);
      }
      child.once("exit", () => resolve(true));
    }),
    sleep(timeoutMs).then(() => false),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return `--- stdout ---\n${stdout.join("")}\n--- stderr ---\n${stderr.join("")}`;
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

  const stdout: string[] = [];
  const stderr: string[] = [];
  const env = createInstanceEnv({
    stateEnv: state.env,
    extraEnv: options.env ?? {},
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let cleaned = false;

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
      return child;
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
    startGateway: async () => {
      if (child && child.exitCode === null && !child.killed) {
        return;
      }
      const entrypoint = await resolveGatewayEntrypoint(cwd);
      child = spawn(
        "node",
        [
          ...entrypoint,
          "gateway",
          "--port",
          String(port),
          "--bind",
          "loopback",
          "--allow-unconfigured",
          ...(options.gatewayArgs ?? []),
        ],
        {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d) => stdout.push(String(d)));
      child.stderr?.on("data", (d) => stderr.push(String(d)));

      try {
        await waitForPortOpen(
          child,
          stdout,
          stderr,
          port,
          options.startTimeoutMs ?? GATEWAY_START_TIMEOUT_MS,
        );
      } catch (err) {
        await instance.stopGateway();
        throw err;
      }
    },
    stopGateway: async () => {
      if (!child) {
        return;
      }
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      let exited = await waitForGatewayExit(
        child,
        options.stopTimeoutMs ?? GATEWAY_STOP_TIMEOUT_MS,
      );
      if (!exited && child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        exited = await waitForGatewayExit(child, options.stopTimeoutMs ?? GATEWAY_STOP_TIMEOUT_MS);
      }
      if (exited) {
        child = undefined;
      }
    },
    logs: () => formatLogs(stdout, stderr),
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await instance.stopGateway();
      await state.cleanup();
    },
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
  const stdout: string[] = [];
  const stderr: string[] = [];
  const child = spawn(command, args, {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d) => stdout.push(String(d)));
  child.stderr?.on("data", (d) => stderr.push(String(d)));

  const completed = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    sleep(params.timeoutMs).then(() => null),
  ]);
  if (completed === null) {
    child.kill("SIGKILL");
    await waitForGatewayExit(child, GATEWAY_STOP_TIMEOUT_MS);
    throw new Error(
      `command timed out after ${params.timeoutMs}ms: ${params.args.join(" ")}\n${formatLogs(stdout, stderr)}`,
    );
  }
  return {
    ...completed,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}
