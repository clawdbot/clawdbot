#!/usr/bin/env -S node --import tsx
// Telegram Mantis SUT script owns the isolated OpenClaw side of desktop proof.

import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";
import { coerceErrorMessage } from "../lib/error-format.mts";
import { sleep } from "../lib/sleep.mjs";
import { createPnpmRunnerSpawnSpec } from "../pnpm-runner.mts";
import { readTextFileTail } from "./lib/text-file-utils.mjs";
import { telegramBotApi } from "./telegram-bot-api.ts";

type GatewaySpawnSpec = {
  args: string[];
  command: string;
  options: SpawnOptionsWithoutStdio;
};

type JsonObject = Record<string, unknown>;
type MantisSutLane = "baseline" | "candidate";
type SpawnedDaemon = { child: ReturnType<typeof spawn>; error?: Error };

type MantisSutExecResult = {
  exitCode: number;
  stderr: string;
  stderrBytes: number;
  stdout: string;
  stdoutBytes: number;
  truncated: boolean;
};

const MAX_EXEC_OUTPUT_BYTES = 64 * 1024;

function mergeConfig(base: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = isRecord(value) ? mergeConfig(merged[key], value) : value;
    }
  }
  return merged;
}

type MantisSutRuntime = {
  configPath: string;
  containerName: string;
  drained: {
    drained: number;
    pendingAfter?: number;
    pendingBefore?: number;
    webhookUrlSet: boolean;
  };
  gatewayLog: string;
  gatewayPid: number;
  mockLog: string;
  mockResponseControl: string;
  proxyControl: string;
  proxyRequestLog: string;
  requestLog: string;
  stateDir: string;
  sutAttestation: { lane: MantisSutLane; sha: string };
  tempRoot: string;
  workspace: string;
};

export type MantisSutRecovery = Pick<
  MantisSutRuntime,
  | "containerName"
  | "gatewayLog"
  | "mockLog"
  | "mockResponseControl"
  | "proxyControl"
  | "proxyRequestLog"
  | "requestLog"
  | "tempRoot"
>;

function childProcessBaseEnv(): NodeJS.ProcessEnv {
  const keys = [
    "CI",
    "COREPACK_HOME",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_OPTIONS",
    "OPENCLAW_BUILD_PRIVATE_QA",
    "OPENCLAW_ENABLE_PRIVATE_QA_CLI",
    "PATH",
    "PNPM_HOME",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

export function createMantisMockServerEnv(params: {
  mockPort: number;
  mockResponseChunkDelayMs?: number;
  mockResponseText: string;
  requestLog: string;
}): NodeJS.ProcessEnv {
  return {
    ...childProcessBaseEnv(),
    MOCK_PORT: String(params.mockPort),
    MOCK_REQUEST_LOG: params.requestLog,
    SUCCESS_MARKER: params.mockResponseText,
    ...(params.mockResponseChunkDelayMs === undefined
      ? {}
      : { MOCK_RESPONSE_CHUNK_DELAY_MS: String(params.mockResponseChunkDelayMs) }),
  };
}

export function createMantisGatewayEnv(params: {
  configPath: string;
  gatewayPassword?: string;
  stateDir: string;
  sutToken: string;
  tailscaleProxyDir?: string;
}): NodeJS.ProcessEnv {
  return {
    ...childProcessBaseEnv(),
    OPENAI_API_KEY: "sk-openclaw-e2e-mock",
    OPENCLAW_CONFIG_PATH: params.configPath,
    ...(params.gatewayPassword ? { OPENCLAW_GATEWAY_PASSWORD: params.gatewayPassword } : {}),
    OPENCLAW_STATE_DIR: params.stateDir,
    ...(params.tailscaleProxyDir
      ? { PATH: `${params.tailscaleProxyDir}${path.delimiter}${process.env.PATH ?? ""}` }
      : {}),
    TELEGRAM_BOT_TOKEN: params.sutToken,
  };
}

export function createOpenClawGatewaySpawnSpec(params: {
  env: NodeJS.ProcessEnv;
  gatewayPort: number;
  repoRoot: string;
  comSpec?: string;
  nodeExecPath?: string;
  npmExecPath?: string;
  pnpmExecPath?: string;
  platform?: NodeJS.Platform;
}): GatewaySpawnSpec {
  if (params.pnpmExecPath) {
    return {
      args: ["openclaw", "gateway", "--port", String(params.gatewayPort)],
      command: params.pnpmExecPath,
      options: { cwd: params.repoRoot, env: params.env, shell: false },
    };
  }
  const spec = createPnpmRunnerSpawnSpec({
    comSpec: params.comSpec,
    cwd: params.repoRoot,
    env: params.env,
    nodeExecPath: params.nodeExecPath,
    npmExecPath: params.npmExecPath,
    platform: params.platform,
    pnpmArgs: ["openclaw", "gateway", "--port", String(params.gatewayPort)],
  });
  return {
    args: spec.args,
    command: spec.command,
    options: {
      cwd: spec.options.cwd,
      env: spec.options.env,
      shell: spec.options.shell,
      windowsVerbatimArguments: spec.options.windowsVerbatimArguments,
    },
  };
}

export function writeSutConfig(params: {
  configPatch?: Record<string, unknown>;
  fixturePluginsDir?: string;
  gatewayPort: number;
  groupId: string;
  mcpAppFixture?: boolean;
  mockHost: string;
  mockPort: number;
  outputDir: string;
  repoRoot?: string;
  telegramApiRoot?: string;
  testerId: string;
}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-crabbox-sut-"));
  const stateDir = path.join(tempRoot, "state");
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  let fixturePluginsRoot: string | undefined;
  if (params.fixturePluginsDir) {
    fixturePluginsRoot = path.join(tempRoot, "fixture-plugins");
    // Fixture code crosses into the same isolated runtime as candidate code. Copying keeps
    // agent staging immutable from the SUT while adding no authority outside the container.
    fs.cpSync(params.fixturePluginsDir, fixturePluginsRoot, { recursive: true });
  }
  const configPath = path.join(tempRoot, "openclaw.json");
  const baseConfig = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-luna" },
        models: {
          "openai/gpt-5.6-luna": { params: { openaiWsWarmup: false, transport: "sse" } },
        },
        // Keep the pdf tool on the one catalog model instead of walking fallback
        // candidates the mock never scripted.
        pdfModel: { primary: "openai/gpt-5.6-luna" },
      },
      entries: {
        main: {
          default: true,
          model: { primary: "openai/gpt-5.6-luna" },
          name: "Main",
          workspace,
        },
      },
    },
    logging: { audit: { enabled: true, executionIdentity: true, messages: "direct" } },
    channels: {
      telegram: {
        allowFrom: [params.testerId],
        ...(params.telegramApiRoot ? { apiRoot: params.telegramApiRoot } : {}),
        botToken: { id: "TELEGRAM_BOT_TOKEN", provider: "default", source: "env" },
        commands: { native: true, nativeSkills: false },
        dmPolicy: "allowlist",
        enabled: true,
        groupAllowFrom: [params.testerId],
        groupPolicy: "allowlist",
        groups: {
          [params.groupId]: {
            allowFrom: [params.testerId],
            groupPolicy: "allowlist",
            requireMention: false,
          },
        },
      },
    },
    commands: { ownerAllowFrom: [`telegram:${params.testerId}`] },
    gateway: params.mcpAppFixture
      ? {
          auth: {
            mode: "password",
            password: {
              id: "OPENCLAW_GATEWAY_PASSWORD",
              provider: "default",
              source: "env",
            },
          },
          bind: "loopback",
          mode: "local",
          port: params.gatewayPort,
          tailscale: { mode: "funnel" },
        }
      : { auth: { mode: "none" }, bind: "loopback", mode: "local", port: params.gatewayPort },
    ...(params.mcpAppFixture
      ? {
          mcp: {
            servers: {
              fixture: {
                args: [
                  path.join(
                    params.repoRoot ?? process.cwd(),
                    "scripts/e2e/mcp-app-conformance-server.mjs",
                  ),
                ],
                command: process.execPath,
              },
            },
          },
        }
      : {}),
    messages: { groupChat: { visibleReplies: "automatic" } },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          baseUrl: `http://${params.mockHost}:${params.mockPort}/v1`,
          models: [
            {
              api: "openai-responses",
              contextWindow: 128000,
              id: "gpt-5.6-luna",
              name: "gpt-5.6-luna",
            },
          ],
          request: { allowPrivateNetwork: true },
        },
      },
    },
    plugins: {
      allow: ["telegram", "openai"],
      enabled: true,
      entries: { openai: { enabled: true }, telegram: { enabled: true } },
      ...(fixturePluginsRoot ? { load: { paths: [fixturePluginsRoot] } } : {}),
    },
  };
  const config = mergeConfig(baseConfig, params.configPatch ?? {});
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, stateDir, tempRoot, workspace };
}

function telegramResultObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload.`);
  }
  return value as JsonObject;
}

export async function drainSutUpdates(sutToken: string) {
  const before = telegramResultObject(
    await telegramBotApi(sutToken, "getWebhookInfo", {}),
    "getWebhookInfo",
  );
  const rawUpdates = await telegramBotApi(sutToken, "getUpdates", {
    allowed_updates: ["message", "edited_message"],
    timeout: 0,
  });
  if (!Array.isArray(rawUpdates)) {
    throw new Error("getUpdates returned an invalid payload.");
  }
  if (rawUpdates.length) {
    const last = rawUpdates.at(-1);
    if (
      last &&
      typeof last === "object" &&
      "update_id" in last &&
      typeof last.update_id === "number"
    ) {
      await telegramBotApi(sutToken, "getUpdates", { offset: last.update_id + 1, timeout: 0 });
    }
  }
  const after = telegramResultObject(
    await telegramBotApi(sutToken, "getWebhookInfo", {}),
    "getWebhookInfo",
  );
  return {
    drained: rawUpdates.length,
    pendingAfter:
      typeof after.pending_update_count === "number" ? after.pending_update_count : undefined,
    pendingBefore:
      typeof before.pending_update_count === "number" ? before.pending_update_count : undefined,
    webhookUrlSet: typeof before.url === "string" && before.url.length > 0,
  };
}

function spawnDaemon(params: {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
}): SpawnedDaemon {
  const log = fs.openSync(params.logPath, "a");
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    detached: true,
    env: params.env,
    shell: params.shell,
    stdio: ["ignore", log, log],
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  });
  const daemon: SpawnedDaemon = { child };
  child.on("error", (error) => {
    daemon.error = error;
  });
  child.unref();
  fs.closeSync(log);
  return daemon;
}

function readLogTail(logPath: string, maxBytes = 256 * 1024): string {
  return readTextFileTail(logPath, Math.max(1, maxBytes));
}

function logTailDiagnostic(logPath: string): string {
  const tail = sliceUtf16Safe(readLogTail(logPath), -4000);
  return `${path.basename(logPath)}:${tail ? `\n${tail}` : " <empty>"}`;
}

function describeDaemonFailure(daemon: SpawnedDaemon): string | undefined {
  if (daemon.error) {
    return `failed to start: ${daemon.error.message}`;
  }
  if (daemon.child.signalCode) {
    return `was terminated by signal ${daemon.child.signalCode}`;
  }
  if (daemon.child.exitCode !== null) {
    return `exited with exit code ${daemon.child.exitCode}`;
  }
  return undefined;
}

export async function waitForLog(
  logPath: string,
  pattern: RegExp,
  label: string,
  timeoutMs: number,
  daemonContext?: { daemon: SpawnedDaemon; logPath: string },
): Promise<void> {
  const started = Date.now();
  while (true) {
    if (pattern.test(readLogTail(logPath))) {
      return;
    }
    if (daemonContext) {
      // The awaited log lives inside the daemon, so a daemon that already died can never
      // satisfy the pattern: report how it died instead of waiting out the full timeout.
      const failure = describeDaemonFailure(daemonContext.daemon);
      if (failure) {
        throw new Error(
          `Container-isolated SUT ${failure} before ${label} became ready.\n${logTailDiagnostic(daemonContext.logPath)}\n${logTailDiagnostic(logPath)}`,
        );
      }
    }
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(500, remainingMs));
  }
  const timeoutDetail = daemonContext
    ? `; container-isolated SUT is still running (pid ${daemonContext.daemon.child.pid ?? "unknown"}).\n${logTailDiagnostic(daemonContext.logPath)}\n${logTailDiagnostic(logPath)}`
    : `\n${sliceUtf16Safe(readLogTail(logPath), -4000)}`;
  throw new Error(`${label} did not become ready within ${timeoutMs}ms${timeoutDetail}`);
}

export async function waitForLogAfter(
  logPath: string,
  offset: number,
  pattern: RegExp,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  let cursor = offset;
  let carry = "";
  while (true) {
    if (fs.existsSync(logPath)) {
      const size = fs.statSync(logPath).size;
      if (size < cursor) {
        cursor = 0;
        carry = "";
      }
      if (size > cursor) {
        const descriptor = fs.openSync(logPath, "r");
        try {
          const buffer = Buffer.alloc(Math.min(64 * 1024, size - cursor));
          while (cursor < size) {
            const bytesRead = fs.readSync(
              descriptor,
              buffer,
              0,
              Math.min(buffer.length, size - cursor),
              cursor,
            );
            if (bytesRead === 0) {
              break;
            }
            cursor += bytesRead;
            const text = `${carry}${buffer.subarray(0, bytesRead).toString("utf8")}`;
            if (pattern.test(text)) {
              return;
            }
            carry = text.slice(-256);
          }
        } finally {
          fs.closeSync(descriptor);
        }
      }
    }
    const remainingMs = timeoutMs - (Date.now() - started);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(250, remainingMs));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

export function createContainerizedSutSpawnSpec(params: {
  containerName: string;
  gatewayPort: number;
  mockPort: number;
  mockResponseChunkDelayMs?: number;
  mockResponseText: string;
  repoRoot: string;
  runtimeRoot: string;
  sutLane: MantisSutLane;
  gatewayEnv: NodeJS.ProcessEnv;
}) {
  const containerHome = path.join(params.runtimeRoot, "container-home");
  fs.mkdirSync(containerHome, { recursive: true });
  const inputPath = path.join(params.runtimeRoot, "container-input.json");
  fs.writeFileSync(
    inputPath,
    `${JSON.stringify({
      gatewayPassword: params.gatewayEnv.OPENCLAW_GATEWAY_PASSWORD,
      mockResponseChunkDelayMs: params.mockResponseChunkDelayMs,
      mockResponseText: params.mockResponseText,
      telegramBotToken: params.gatewayEnv.TELEGRAM_BOT_TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    args: [
      "-n",
      "/usr/local/sbin/openclaw-mantis-sut-container",
      "run",
      params.containerName,
      params.sutLane,
      params.repoRoot,
      params.runtimeRoot,
      String(params.gatewayPort),
      String(params.mockPort),
    ],
    command: "sudo",
    inputPath,
    options: {
      cwd: process.cwd(),
      env: childProcessBaseEnv(),
      shell: false,
    } satisfies SpawnOptionsWithoutStdio,
  };
}

type SutContainerAction = "destroy" | "restart" | "stop";
type SutContainerCommandRunner = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv; stdio: "pipe" },
) => {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status: number | null;
  stderr?: string;
};

export function runSutContainerAction(
  action: SutContainerAction,
  containerName: string | undefined,
  runtimeRoot: string | undefined,
  run: SutContainerCommandRunner = spawnSync,
): void {
  if (!containerName || !runtimeRoot) {
    return;
  }
  const result = run(
    "sudo",
    ["-n", "/usr/local/sbin/openclaw-mantis-sut-container", action, containerName, runtimeRoot],
    { encoding: "utf8", env: childProcessBaseEnv(), stdio: "pipe" },
  );
  if (result.error) {
    throw new Error(`Failed to ${action} container-isolated SUT: ${result.error.message}`, {
      cause: result.error,
    });
  }
  const stderr = result.stderr?.toString().trim().slice(-4_000);
  if (result.signal) {
    throw new Error(
      `Container-isolated SUT ${action} was terminated by ${result.signal}.${stderr ? `\n${stderr}` : ""}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Container-isolated SUT ${action} failed with exit code ${result.status ?? "unknown"}.${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

function collectBoundedOutput(stream: NodeJS.ReadableStream): {
  bytes: () => number;
  text: () => string;
} {
  let byteCount = 0;
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  stream.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteCount += chunk.length;
    const remaining = MAX_EXEC_OUTPUT_BYTES - retainedBytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      chunks.push(retained);
      retainedBytes += retained.length;
    }
  });
  return {
    bytes: () => byteCount,
    text: () => Buffer.concat(chunks, retainedBytes).toString("utf8"),
  };
}

export async function execMantisSut(
  sut: Pick<MantisSutRuntime, "containerName" | "tempRoot">,
  command: string,
  timeoutSeconds: number,
): Promise<MantisSutExecResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "sudo",
      [
        "-n",
        "/usr/local/sbin/openclaw-mantis-sut-container",
        "exec",
        sut.containerName,
        sut.tempRoot,
        "--timeout-seconds",
        String(timeoutSeconds),
        "--",
        command,
      ],
      { env: childProcessBaseEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout = collectBoundedOutput(child.stdout);
    const stderr = collectBoundedOutput(child.stderr);
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      if (spawnError) {
        reject(
          new Error(`Failed to exec in container-isolated SUT: ${spawnError.message}`, {
            cause: spawnError,
          }),
        );
        return;
      }
      if (signal) {
        reject(new Error(`Container-isolated SUT exec was terminated by ${signal}.`));
        return;
      }
      const stdoutBytes = stdout.bytes();
      const stderrBytes = stderr.bytes();
      resolve({
        exitCode: exitCode ?? 1,
        stderr: stderr.text(),
        stderrBytes,
        stdout: stdout.text(),
        stdoutBytes,
        truncated: stdoutBytes > MAX_EXEC_OUTPUT_BYTES || stderrBytes > MAX_EXEC_OUTPUT_BYTES,
      });
    });
  });
}

export function restartMantisSut(sut: Pick<MantisSutRuntime, "containerName" | "tempRoot">): void {
  runSutContainerAction("restart", sut.containerName, sut.tempRoot);
}

export function preserveMantisSutRuntimeArtifacts(
  sut: Pick<MantisSutRuntime, "gatewayLog" | "mockLog" | "requestLog"> & {
    proxyRequestLog?: string;
  },
  outputDir: string,
): void {
  for (const source of [sut.gatewayLog, sut.mockLog, sut.requestLog, sut.proxyRequestLog]) {
    if (!source) {
      continue;
    }
    const target = path.join(outputDir, path.basename(source));
    if (path.resolve(source) !== path.resolve(target) && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    }
  }
}

export function stopMantisSut(sut: Pick<MantisSutRuntime, "containerName" | "tempRoot">): void {
  runSutContainerAction("stop", sut.containerName, sut.tempRoot);
}

export function destroyMantisSut(sut: Pick<MantisSutRuntime, "containerName" | "tempRoot">): void {
  runSutContainerAction("destroy", sut.containerName, sut.tempRoot);
}

function cleanupFailureMessage(message: string, cleanupErrors: unknown[]): string {
  return [
    message,
    ...cleanupErrors.map((error) => `Cleanup failure: ${coerceErrorMessage(error)}`),
  ].join("\n");
}

export async function startMantisSut(params: {
  configPatch?: Record<string, unknown>;
  fixturePluginsDir?: string;
  gatewayPort: number;
  groupId: string;
  mockPort: number;
  mockResponseChunkDelayMs?: number;
  mockResponseText: string;
  outputDir: string;
  repoRoot: string;
  sutLane: MantisSutLane;
  sutToken: string;
  testerId: string;
  onRuntimeCreated?: (runtime: MantisSutRecovery) => void;
  onRuntimeDisposed?: () => void;
}): Promise<MantisSutRuntime> {
  const drained = await drainSutUpdates(params.sutToken);
  const config = writeSutConfig({
    ...params,
    mockHost: "mock-openai",
    telegramApiRoot: "http://telegram-api-proxy:8080",
  });
  // The root wrapper relocates tempRoot into its bounded filesystem, then restores this
  // exact path as a symlink before Docker starts. Keep controller and claim paths anchored
  // here so live log reads, mock updates, stop, and destroy all share one runtime identity.
  const mockResponseControlDir = path.join(config.tempRoot, "mock-control");
  fs.mkdirSync(mockResponseControlDir, { mode: 0o700 });
  const mockResponseControl = path.join(mockResponseControlDir, "response.json");
  const requestLog = path.join(mockResponseControlDir, "mock-openai-requests.ndjson");
  const mockLog = path.join(mockResponseControlDir, "mock-openai.log");
  fs.writeFileSync(
    mockResponseControl,
    `${JSON.stringify({
      chunkDelayMs: params.mockResponseChunkDelayMs ?? 0,
      text: params.mockResponseText,
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(requestLog, "", { mode: 0o600 });
  fs.writeFileSync(mockLog, "", { mode: 0o600 });
  const proxyControlDir = path.join(config.tempRoot, "proxy-control");
  fs.mkdirSync(proxyControlDir, { mode: 0o700 });
  const proxyControl = path.join(proxyControlDir, "control.json");
  const proxyRequestLog = path.join(proxyControlDir, "requests.ndjson");
  fs.writeFileSync(proxyControl, '{"rules":[]}\n', { mode: 0o600 });
  fs.writeFileSync(proxyRequestLog, "", { mode: 0o600 });
  const gatewayLog = path.join(config.tempRoot, "gateway.log");
  const gatewayEnv = createMantisGatewayEnv({ ...config, sutToken: params.sutToken });
  const containerName = `openclaw-telegram-sut-${randomUUID()}`;
  const spec = createContainerizedSutSpawnSpec({
    containerName,
    gatewayEnv,
    gatewayPort: params.gatewayPort,
    mockPort: params.mockPort,
    mockResponseChunkDelayMs: params.mockResponseChunkDelayMs,
    mockResponseText: params.mockResponseText,
    repoRoot: params.repoRoot,
    runtimeRoot: config.tempRoot,
    sutLane: params.sutLane,
  });
  params.onRuntimeCreated?.({
    containerName,
    gatewayLog,
    mockLog,
    mockResponseControl,
    proxyControl,
    proxyRequestLog,
    requestLog,
    tempRoot: config.tempRoot,
  });
  try {
    const daemonLogPath = path.join(params.outputDir, "sut-container.log");
    const daemon = spawnDaemon({
      args: spec.args,
      command: spec.command,
      cwd: typeof spec.options.cwd === "string" ? spec.options.cwd : process.cwd(),
      env: spec.options.env ?? {},
      logPath: daemonLogPath,
      shell: false,
    });
    const daemonContext = { daemon, logPath: daemonLogPath };
    await waitForLog(mockLog, /mock-openai listening/u, "mock-openai", 30_000, daemonContext);
    await waitForLog(gatewayLog, /\[gateway\] ready/u, "gateway", 60_000, daemonContext);
    const gatewayPid = daemon.child.pid;
    if (!gatewayPid) {
      throw new Error("Container-isolated SUT became ready without a daemon process id.");
    }
    const sutAttestation = z
      .object({ lane: z.enum(["baseline", "candidate"]), sha: z.string().regex(/^[0-9a-f]{40}$/u) })
      .parse(
        JSON.parse(fs.readFileSync(path.join(config.tempRoot, "sut-attestation.json"), "utf8")),
      );
    if (sutAttestation.lane !== params.sutLane) {
      throw new Error("Container-isolated SUT attestation mismatch.");
    }
    return {
      ...config,
      containerName,
      drained,
      gatewayLog,
      gatewayPid,
      mockLog,
      mockResponseControl,
      proxyControl,
      proxyRequestLog,
      requestLog,
      sutAttestation,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let stopped = false;
    try {
      runSutContainerAction("stop", containerName, config.tempRoot);
      stopped = true;
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (stopped) {
      try {
        preserveMantisSutRuntimeArtifacts(
          { gatewayLog, mockLog, proxyRequestLog, requestLog },
          params.outputDir,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      runSutContainerAction("destroy", containerName, config.tempRoot);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    fs.rmSync(spec.inputPath, { force: true });
    if (cleanupErrors.length > 0) {
      throw new Error(
        cleanupFailureMessage(
          "Local SUT startup failed and cleanup was incomplete.",
          cleanupErrors,
        ),
        { cause: error },
      );
    }
    params.onRuntimeDisposed?.();
    throw error;
  }
}
