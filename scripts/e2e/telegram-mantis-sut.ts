#!/usr/bin/env -S node --import tsx
// Telegram Mantis SUT script owns the isolated OpenClaw side of desktop proof.

import { spawn, spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

type FunnelBridge = {
  proxyPath: string;
  tunnelLog: string;
  tunnelPid: number;
};

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
  mockPid: number;
  requestLog: string;
  stateDir: string;
  sutAttestation: { lane: MantisSutLane; sha: string };
  tempRoot: string;
  workspace: string;
  funnelBridge?: FunnelBridge;
};

const credentialPayloadSchema = z.object({
  groupId: z.string().regex(/^-100\d+$/u),
  sutToken: z.string().min(1),
  testerUserId: z.union([z.string(), z.number()]).transform(String),
});

const sutRuntimeSchema = z.object({
  configPath: z.string().min(1),
  containerName: z.string().min(1),
  gatewayLog: z.string().min(1),
  gatewayPid: z.number().int().positive(),
  mockLog: z.string().min(1),
  mockPid: z.number().int().positive(),
  requestLog: z.string().min(1),
  stateDir: z.string().min(1),
  sutAttestation: z.object({
    lane: z.enum(["baseline", "candidate"]),
    sha: z.string().regex(/^[0-9a-f]{40}$/u),
  }),
  tempRoot: z.string().min(1),
  workspace: z.string().min(1),
});

const sutSessionSchema = z.object({
  command: z.literal("telegram-mantis-sut-session"),
  createdAt: z.string(),
  outputDir: z.string().min(1),
  runtime: sutRuntimeSchema,
  schemaVersion: z.literal(1),
  telegram: z.object({
    botToken: z.string().min(1),
    chat: z.string().regex(/^-100\d+$/u),
  }),
});

const recorderArtifactsSchema = z.object({
  artifacts: z.record(z.string(), z.string()),
  cleanupErrors: z.array(z.string()).optional(),
  stoppedAt: z.string(),
});

type MantisSutSession = z.infer<typeof sutSessionSchema>;

const DEFAULT_GATEWAY_PORT = 19_879;
const DEFAULT_MOCK_PORT = 19_882;
const CREDENTIAL_PAYLOAD_ENV = "OPENCLAW_TELEGRAM_USER_CREDENTIAL_PAYLOAD";

function usageText(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/e2e/telegram-mantis-sut.ts start --lane <baseline|candidate> --repo-root <path> --output-dir <dir>",
    "  node --import tsx scripts/e2e/telegram-mantis-sut.ts stop --session <file>",
    "",
    "Start proof controls: --mock-response-file <path> --mock-response-chunk-delay-ms <ms> --human-delay-fixed-ms <ms> --link-preview <true|false>",
  ].join("\n");
}

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
  gatewayPort: number;
  groupId: string;
  humanDelayFixedMs?: number;
  linkPreview?: boolean;
  mcpAppFixture?: boolean;
  mockPort: number;
  outputDir: string;
  repoRoot?: string;
  testerId: string;
}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-crabbox-sut-"));
  const stateDir = path.join(tempRoot, "state");
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(tempRoot, "openclaw.json");
  const config = {
    agents: {
      defaults: {
        ...(params.humanDelayFixedMs === undefined
          ? {}
          : {
              humanDelay: {
                maxMs: params.humanDelayFixedMs,
                minMs: params.humanDelayFixedMs,
                mode: "custom",
              },
            }),
        model: { primary: "openai/gpt-5.6-luna" },
        models: {
          "openai/gpt-5.6-luna": { params: { openaiWsWarmup: false, transport: "sse" } },
        },
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
        ...(params.linkPreview === undefined ? {} : { linkPreview: params.linkPreview }),
        replyToMode: "first",
      },
    },
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
          baseUrl: `http://127.0.0.1:${params.mockPort}/v1`,
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
    },
  };
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
}): number | undefined {
  const log = fs.openSync(params.logPath, "a");
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    detached: true,
    env: params.env,
    shell: params.shell,
    stdio: ["ignore", log, log],
    windowsVerbatimArguments: params.windowsVerbatimArguments,
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

function readLogTail(logPath: string, maxBytes = 256 * 1024): string {
  return readTextFileTail(logPath, Math.max(1, maxBytes));
}

export async function waitForLog(
  logPath: string,
  pattern: RegExp,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pattern.test(readLogTail(logPath))) {
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `${label} did not become ready within ${timeoutMs}ms\n${sliceUtf16Safe(readLogTail(logPath), -4000)}`,
  );
}

export function createContainerizedSutSpawnSpec(params: {
  codexProxyPort: number;
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
      String(params.codexProxyPort),
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

export function readCodexProxyPort(codexHome: string): number | undefined {
  let config: string;
  try {
    config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  const section = config.match(
    /\[model_providers\.codex-action-responses-proxy\]([\s\S]*?)(?=\n\[|$)/u,
  )?.[1];
  const match = section?.match(/base_url\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)\/v1"/u);
  if (!match?.[1]) {
    return undefined;
  }
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function requireCodexProxyPort(): number {
  const codexHome = process.env.CODEX_HOME?.trim();
  if (!codexHome) {
    throw new Error("Fork SUT isolation requires CODEX_HOME for the proxy boundary check.");
  }
  const proxyPort = readCodexProxyPort(codexHome);
  if (!proxyPort) {
    throw new Error("Fork SUT isolation could not resolve the Codex Responses proxy port.");
  }
  return proxyPort;
}

type SutContainerAction = "destroy" | "stop";
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
  if (result.signal) {
    throw new Error(`Container-isolated SUT ${action} was terminated by ${result.signal}.`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim().slice(-4_000);
    throw new Error(
      `Container-isolated SUT ${action} failed with exit code ${result.status ?? "unknown"}.${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

export function preserveMantisSutRuntimeArtifacts(
  sut: Pick<MantisSutRuntime, "gatewayLog" | "mockLog" | "requestLog">,
  outputDir: string,
): void {
  for (const source of [sut.gatewayLog, sut.mockLog, sut.requestLog]) {
    const target = path.join(outputDir, path.basename(source));
    if (path.resolve(source) !== path.resolve(target) && fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    }
  }
}

function stopMantisSut(sut: Pick<MantisSutRuntime, "containerName" | "tempRoot">): void {
  runSutContainerAction("stop", sut.containerName, sut.tempRoot);
}

function destroyMantisSut(sut: Pick<MantisSutRuntime, "containerName" | "tempRoot">): void {
  runSutContainerAction("destroy", sut.containerName, sut.tempRoot);
}

function cleanupFailureMessage(message: string, cleanupErrors: unknown[]): string {
  return [
    message,
    ...cleanupErrors.map((error) => `Cleanup failure: ${coerceErrorMessage(error)}`),
  ].join("\n");
}

export async function startMantisSut(params: {
  gatewayPort: number;
  groupId: string;
  humanDelayFixedMs?: number;
  linkPreview?: boolean;
  mockPort: number;
  mockResponseChunkDelayMs?: number;
  mockResponseText: string;
  outputDir: string;
  repoRoot: string;
  sutLane: MantisSutLane;
  sutToken: string;
  testerId: string;
}): Promise<MantisSutRuntime> {
  const drained = await drainSutUpdates(params.sutToken);
  const config = writeSutConfig(params);
  const requestLog = path.join(config.tempRoot, "mock-openai-requests.ndjson");
  const mockLog = path.join(config.tempRoot, "mock-openai.log");
  const gatewayLog = path.join(config.tempRoot, "gateway.log");
  const gatewayEnv = createMantisGatewayEnv({ ...config, sutToken: params.sutToken });
  const containerName = `openclaw-telegram-sut-${randomUUID()}`;
  const spec = createContainerizedSutSpawnSpec({
    codexProxyPort: requireCodexProxyPort(),
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
  let gatewayPid: number | undefined;
  try {
    gatewayPid = spawnDaemon({
      args: spec.args,
      command: spec.command,
      cwd: typeof spec.options.cwd === "string" ? spec.options.cwd : process.cwd(),
      env: spec.options.env ?? {},
      logPath: path.join(params.outputDir, "sut-container.log"),
      shell: false,
    });
    if (!gatewayPid) {
      throw new Error("container-isolated SUT did not start.");
    }
    await waitForLog(mockLog, /mock-openai listening/u, "mock-openai", 30_000);
    await waitForLog(gatewayLog, /\[gateway\] ready/u, "gateway", 60_000);
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
      mockPid: gatewayPid,
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
        preserveMantisSutRuntimeArtifacts({ gatewayLog, mockLog, requestLog }, params.outputDir);
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
    throw error;
  }
}

function requiredOption(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required.\n\n${usageText()}`);
  }
  return value;
}

function parseOptions(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid arguments.\n\n${usageText()}`);
    }
    if (values.has(name)) {
      throw new Error(`${name} was provided more than once.`);
    }
    values.set(name, value);
  }
  return values;
}

function resolveOutputDir(value: string): string {
  if (path.isAbsolute(value)) {
    throw new Error("--output-dir must be repo-relative.");
  }
  const resolved = path.resolve(value);
  const relative = path.relative(process.cwd(), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output-dir must stay inside the repository.");
  }
  return resolved;
}

function writePrivateJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function startCli(values: Map<string, string>): Promise<void> {
  const allowed = new Set([
    "--human-delay-fixed-ms",
    "--lane",
    "--link-preview",
    "--mock-response-chunk-delay-ms",
    "--mock-response-file",
    "--output-dir",
    "--repo-root",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown start option: ${name}`);
    }
  }
  const lane = z.enum(["baseline", "candidate"]).parse(requiredOption(values, "--lane"));
  const repoRoot = path.resolve(requiredOption(values, "--repo-root"));
  const outputDir = resolveOutputDir(requiredOption(values, "--output-dir"));
  const positiveInteger = (name: string): number | undefined => {
    const value = values.get(name);
    if (value === undefined) {
      return undefined;
    }
    if (!/^\d+$/u.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return Number(value);
  };
  const linkPreviewValue = values.get("--link-preview");
  if (
    linkPreviewValue !== undefined &&
    linkPreviewValue !== "true" &&
    linkPreviewValue !== "false"
  ) {
    throw new Error("--link-preview must be true or false.");
  }
  const mockResponseFile = values.get("--mock-response-file");
  const credentialFile = process.env[CREDENTIAL_PAYLOAD_ENV]?.trim();
  if (!credentialFile) {
    throw new Error(`${CREDENTIAL_PAYLOAD_ENV} is required.`);
  }
  const credential = credentialPayloadSchema.parse(
    JSON.parse(fs.readFileSync(credentialFile, "utf8")),
  );
  fs.mkdirSync(outputDir, { recursive: true });
  const runtime = await startMantisSut({
    gatewayPort: DEFAULT_GATEWAY_PORT,
    groupId: credential.groupId,
    humanDelayFixedMs: positiveInteger("--human-delay-fixed-ms"),
    linkPreview: linkPreviewValue === undefined ? undefined : linkPreviewValue === "true",
    mockPort: DEFAULT_MOCK_PORT,
    mockResponseChunkDelayMs: positiveInteger("--mock-response-chunk-delay-ms"),
    mockResponseText: mockResponseFile
      ? fs.readFileSync(path.resolve(mockResponseFile), "utf8")
      : "OPENCLAW_E2E_OK",
    outputDir,
    repoRoot,
    sutLane: lane,
    sutToken: credential.sutToken,
    testerId: credential.testerUserId,
  });
  const sessionPath = path.join(outputDir, "sut.json");
  writePrivateJson(sessionPath, {
    command: "telegram-mantis-sut-session",
    createdAt: new Date().toISOString(),
    outputDir,
    runtime,
    schemaVersion: 1,
    telegram: { botToken: credential.sutToken, chat: credential.groupId },
  } satisfies MantisSutSession);
  console.log(
    JSON.stringify({ session: path.relative(process.cwd(), sessionPath), status: "pass" }),
  );
}

function stopCli(values: Map<string, string>): void {
  if (values.size !== 1 || !values.has("--session")) {
    throw new Error(`stop requires only --session.\n\n${usageText()}`);
  }
  const sessionPath = path.resolve(requiredOption(values, "--session"));
  const session = sutSessionSchema.parse(JSON.parse(fs.readFileSync(sessionPath, "utf8")));
  const recorderPath = path.join(path.dirname(sessionPath), "recorder.json");
  let stopped = false;
  try {
    stopMantisSut(session.runtime);
    stopped = true;
  } finally {
    if (stopped) {
      preserveMantisSutRuntimeArtifacts(session.runtime, session.outputDir);
    }
    destroyMantisSut(session.runtime);
    fs.rmSync(sessionPath, { force: true });
  }
  if (fs.existsSync(recorderPath)) {
    const recorder = recorderArtifactsSchema.parse(
      JSON.parse(fs.readFileSync(recorderPath, "utf8")),
    );
    writePrivateJson(path.join(session.outputDir, "telegram-user-crabbox-session-summary.json"), {
      artifacts: recorder.artifacts,
      status: recorder.cleanupErrors ? "fail" : "pass",
      sutAttestation: session.runtime.sutAttestation,
    });
  }
  console.log(JSON.stringify({ status: "pass" }));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    console.log(usageText());
    return;
  }
  const values = parseOptions(process.argv.slice(3));
  if (command === "start") {
    await startCli(values);
    return;
  }
  if (command === "stop") {
    stopCli(values);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usageText()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
