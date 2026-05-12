#!/usr/bin/env -S node --import tsx

import { type ChildProcess, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CommandResult = {
  stderr: string;
  stdout: string;
};

type JsonObject = Record<string, unknown>;

type PreviewCrop = "telegram-window";

type CrabboxInspect = {
  host?: string;
  id?: string;
  slug?: string;
  sshKey?: string;
  sshPort?: string;
  sshUser?: string;
  state?: string;
};

type Options = {
  crabboxClass: string;
  command:
    | "finish"
    | "probe"
    | "publish"
    | "run"
    | "screenshot"
    | "send"
    | "start"
    | "status"
    | "view";
  crabboxBin: string;
  desktopChatTitle: string;
  dryRun: boolean;
  envFile?: string;
  expect: string[];
  gatewayPort: number;
  idleTimeout: string;
  keepBox: boolean;
  leaseId?: string;
  mockResponseText: string;
  mockPort: number;
  outputDir: string;
  messageId?: string;
  previewCrop?: PreviewCrop;
  previewFps: number;
  previewCropWidth: number;
  previewWidth: number;
  provider: string;
  publishFullArtifacts: boolean;
  publishPr?: number;
  publishRepo: string;
  publishSummary?: string;
  recordFps: number;
  recordSeconds: number;
  remoteCommand: string[];
  sessionFile?: string;
  sutUsername?: string;
  target: string;
  tdlibSha256?: string;
  tdlibUrl?: string;
  text: string;
  timeoutMs: number;
  ttl: string;
  userDriverScript: string;
};

type LocalSut = {
  configPath: string;
  drained: {
    drained: number;
    pendingAfter?: number;
    pendingBefore?: number;
    webhookUrlSet: boolean;
  };
  mock: ChildProcess;
  mockLog: string;
  requestLog: string;
  stateDir: string;
  tempRoot: string;
  workspace: string;
  gateway: ChildProcess;
  gatewayLog: string;
};

type SessionFile = {
  command: "telegram-user-crabbox-session";
  createdAt: string;
  crabbox: {
    class: string;
    createdLease: boolean;
    id: string;
    inspect: CrabboxInspect;
    provider: string;
    target: string;
  };
  credential: {
    groupId: string;
    leaseFile: string;
    sutUsername: string;
    testerUserId: string;
    testerUsername: string;
  };
  localRoot: string;
  localSut: {
    gatewayLog: string;
    gatewayPid: number;
    mockLog: string;
    mockPid: number;
    requestLog: string;
    stateDir: string;
    tempRoot: string;
    workspace: string;
  };
  outputDir: string;
  recorder: {
    log: string;
    pidFile: string;
    remoteVideo: string;
  };
  remoteRoot: string;
};

const DEFAULT_SKILL_DIR = "~/.codex/skills/custom/telegram-e2e-bot-to-bot";
const DEFAULT_CONVEX_ENV_FILE = `${DEFAULT_SKILL_DIR}/convex.local.env`;
const DEFAULT_USER_DRIVER = "scripts/e2e/telegram-user-driver.py";
const DEFAULT_OUTPUT_ROOT = ".artifacts/qa-e2e/telegram-user-crabbox";
const REMOTE_ROOT = "/tmp/openclaw-telegram-user-crabbox";
const CREDENTIAL_SCRIPT = fileURLToPath(new URL("./telegram-user-credential.ts", import.meta.url));
const TELEGRAM_PROOF_VIEW = {
  cropWidth: 520,
  height: 1000,
  width: 650,
  x: 635,
  y: 40,
};

function usageText() {
  return [
    "Usage:",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts [probe] [--text /status] [--expect OpenClaw]",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts start [--tdlib-url <url>]",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts send --session <session.json> --text <text>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts run --session <session.json> -- <remote command>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts view --session <session.json> --message-id <id>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts screenshot --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts status --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts finish --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts publish --session <session.json> --pr <number>",
    "",
    "Useful options:",
    "  --class <name>                Crabbox machine class. Default: standard.",
    "  --desktop-chat-title <name>   Telegram Desktop chat to select before recording.",
    "  --id <cbx_id>                 Reuse an existing Crabbox desktop lease.",
    "  --keep-box                    Leave the Crabbox lease running for VNC debugging.",
    "  --mock-response-file <path>    Text returned by the mock model.",
    "  --output-dir <path>           Artifact directory under the repo.",
    "  --message-id <id>             Telegram message id for proof-view deep link.",
    "  --preview-crop telegram-window Create a side-by-side friendly Telegram-window GIF.",
    "  --preview-crop-width <pixels>  Cropped preview GIF width. Default: 520.",
    "  --preview-fps <fps>            Motion GIF frames per second. Default: 24.",
    "  --preview-width <pixels>       Motion GIF width. Default: 1920.",
    "  --pr <number>                 Pull request number for publish.",
    "  --record-fps <fps>             Desktop recording frames per second. Default: 24.",
    "  --record-seconds <seconds>    Desktop video duration. Default: 35.",
    "  --repo <owner/name>           GitHub repo for publish. Default: openclaw/openclaw.",
    "  --session <path>              Session file from start. Default: <output-dir>/session.json.",
    "  --summary <text>              Artifact publish summary.",
    "  --full-artifacts              Publish all session artifacts. Default publishes only the motion GIF.",
    "  --tdlib-sha256 <hex>         Expected SHA-256 for --tdlib-url. Defaults to <url>.sha256.",
    "  --tdlib-url <url>             Linux tdlib archive containing libtdjson.so.",
    "  --dry-run                     Validate local inputs and print the plan.",
  ].join("\n");
}

function usage(): never {
  throw new Error(usageText());
}

function expandHome(value: string) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  argv = argv[0] === "--" ? argv.slice(1) : argv;
  const commands = new Set([
    "finish",
    "probe",
    "publish",
    "run",
    "screenshot",
    "send",
    "start",
    "status",
    "view",
  ]);
  const command = commands.has(argv[0] ?? "") ? (argv.shift() as Options["command"]) : "probe";
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const opts: Options = {
    crabboxClass: "standard",
    command,
    crabboxBin: trimToValue(process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN) ?? "crabbox",
    desktopChatTitle:
      trimToValue(process.env.OPENCLAW_TELEGRAM_USER_DESKTOP_CHAT_TITLE) ?? "OpenClaw Testing",
    dryRun: false,
    expect: ["OpenClaw"],
    gatewayPort: 19_879,
    idleTimeout: "60m",
    keepBox: false,
    mockResponseText: "OPENCLAW_E2E_OK",
    mockPort: 19_882,
    outputDir: path.join(DEFAULT_OUTPUT_ROOT, stamp),
    previewCropWidth: TELEGRAM_PROOF_VIEW.cropWidth,
    previewFps: 24,
    previewWidth: 1920,
    provider: process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER?.trim() || "aws",
    publishFullArtifacts: false,
    publishRepo: "openclaw/openclaw",
    recordFps: 24,
    recordSeconds: 35,
    remoteCommand: [],
    target: "linux",
    text: "/status",
    timeoutMs: 90_000,
    ttl: "120m",
    userDriverScript:
      trimToValue(process.env.OPENCLAW_TELEGRAM_USER_DRIVER_SCRIPT) ?? DEFAULT_USER_DRIVER,
  };
  const commandSeparator = argv.indexOf("--");
  if (command === "run" && commandSeparator >= 0) {
    opts.remoteCommand = argv.slice(commandSeparator + 1);
    argv = argv.slice(0, commandSeparator);
  }
  let expectWasPassed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        usage();
      }
      index += 1;
      return value;
    };
    if (arg === "--class") {
      opts.crabboxClass = readValue();
    } else if (arg === "--crabbox-bin") {
      opts.crabboxBin = readValue();
    } else if (arg === "--desktop-chat-title") {
      opts.desktopChatTitle = readValue();
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--env-file") {
      opts.envFile = readValue();
    } else if (arg === "--expect") {
      if (!expectWasPassed) {
        opts.expect = [];
        expectWasPassed = true;
      }
      opts.expect.push(readValue());
    } else if (arg === "--gateway-port") {
      opts.gatewayPort = parsePositiveInteger(readValue(), "--gateway-port");
    } else if (arg === "--id") {
      opts.leaseId = readValue();
    } else if (arg === "--idle-timeout") {
      opts.idleTimeout = readValue();
    } else if (arg === "--keep-box") {
      opts.keepBox = true;
    } else if (arg === "--mock-port") {
      opts.mockPort = parsePositiveInteger(readValue(), "--mock-port");
    } else if (arg === "--mock-response-file") {
      opts.mockResponseText = fs.readFileSync(resolveRepoPath(process.cwd(), readValue()), "utf8");
    } else if (arg === "--message-id") {
      opts.messageId = String(parsePositiveInteger(readValue(), "--message-id"));
    } else if (arg === "--output-dir") {
      opts.outputDir = readValue();
    } else if (arg === "--preview-crop") {
      const value = readValue();
      if (value !== "telegram-window") {
        throw new Error("--preview-crop must be telegram-window.");
      }
      opts.previewCrop = value;
    } else if (arg === "--preview-crop-width") {
      opts.previewCropWidth = parsePositiveInteger(readValue(), "--preview-crop-width");
    } else if (arg === "--preview-fps") {
      opts.previewFps = parsePositiveInteger(readValue(), "--preview-fps");
    } else if (arg === "--preview-width") {
      opts.previewWidth = parsePositiveInteger(readValue(), "--preview-width");
    } else if (arg === "--provider") {
      opts.provider = readValue();
    } else if (arg === "--pr") {
      opts.publishPr = parsePositiveInteger(readValue(), "--pr");
    } else if (arg === "--repo") {
      opts.publishRepo = readValue();
    } else if (arg === "--record-seconds") {
      opts.recordSeconds = parsePositiveInteger(readValue(), "--record-seconds");
    } else if (arg === "--session") {
      opts.sessionFile = readValue();
    } else if (arg === "--summary") {
      opts.publishSummary = readValue();
    } else if (arg === "--full-artifacts") {
      opts.publishFullArtifacts = true;
    } else if (arg === "--record-fps") {
      opts.recordFps = parsePositiveInteger(readValue(), "--record-fps");
    } else if (arg === "--sut-username") {
      opts.sutUsername = readValue().replace(/^@/u, "");
    } else if (arg === "--target") {
      opts.target = readValue();
    } else if (arg === "--tdlib-sha256") {
      opts.tdlibSha256 = readValue().toLowerCase();
    } else if (arg === "--tdlib-url") {
      opts.tdlibUrl = readValue();
    } else if (arg === "--text") {
      opts.text = readValue();
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = parsePositiveInteger(readValue(), "--timeout-ms");
    } else if (arg === "--ttl") {
      opts.ttl = readValue();
    } else if (arg === "--user-driver-script") {
      opts.userDriverScript = readValue();
    } else if (arg === "--help" || arg === "-h") {
      console.log(usageText());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (command === "run" && opts.remoteCommand.length === 0) {
    throw new Error("run requires a remote command after --.");
  }
  if (
    ["finish", "publish", "run", "screenshot", "send", "status", "view"].includes(command) &&
    !opts.sessionFile
  ) {
    throw new Error(`${command} requires --session.`);
  }
  if (command === "view" && !opts.messageId) {
    throw new Error("view requires --message-id.");
  }
  if (command === "publish" && !opts.publishPr) {
    throw new Error("publish requires --pr.");
  }
  return opts;
}

function repoRoot() {
  const cwd = process.cwd();
  if (
    !fs.existsSync(path.join(cwd, "package.json")) ||
    !fs.existsSync(path.join(cwd, "scripts/e2e/mock-openai-server.mjs"))
  ) {
    throw new Error("Run from the OpenClaw repo root.");
  }
  return cwd;
}

function resolveRepoPath(root: string, value: string) {
  const resolved = path.isAbsolute(value) ? value : path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay inside the repo: ${value}`);
  }
  return resolved;
}

function readJsonFile(filePath: string): JsonObject {
  try {
    return JSON.parse(fs.readFileSync(expandHome(filePath), "utf8")) as JsonObject;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function requireString(source: JsonObject, key: string) {
  const value = source[key];
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing ${key}.`);
}

function optionalString(source: JsonObject, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function childProcessBaseEnv() {
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

function mockServerEnv(params: { mockPort: number; mockResponseText: string; requestLog: string }) {
  return {
    ...childProcessBaseEnv(),
    MOCK_PORT: String(params.mockPort),
    MOCK_REQUEST_LOG: params.requestLog,
    SUCCESS_MARKER: params.mockResponseText,
  };
}

function gatewayEnv(params: { configPath: string; stateDir: string; sutToken: string }) {
  return {
    ...childProcessBaseEnv(),
    OPENAI_API_KEY: "sk-openclaw-e2e-mock",
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: params.stateDir,
    TELEGRAM_BOT_TOKEN: params.sutToken,
  };
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCommand(params: {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
  stdin?: string;
}) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (params.stdio === "inherit") {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (params.stdio === "inherit") {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(
        new Error(
          `${params.command} ${params.args.join(" ")} failed with ${detail}\n${stdout}${stderr}`,
        ),
      );
    });
    if (params.stdin) {
      child.stdin.end(params.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function spawnLogged(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  const capture = (chunk: string) => {
    output = `${output}${chunk}`.slice(-12000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return {
    child,
    get output() {
      return output;
    },
  };
}

function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
  output: () => string,
  label: string,
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`${label} did not become ready within ${timeoutMs}ms\n${output().slice(-4000)}`),
      );
    }, timeoutMs);
    const onData = () => {
      if (pattern.test(output())) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `${label} exited before ready with code ${code ?? "unknown"}\n${output().slice(-4000)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
    onData();
  });
}

function killTree(child: ChildProcess | undefined) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function killPidTree(pid: number | undefined) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
}

function spawnDaemon(params: {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const log = fs.openSync(params.logPath, "a");
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    detached: true,
    env: params.env,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

async function waitForLog(logPath: string, pattern: RegExp, label: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    if (pattern.test(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  throw new Error(`${label} did not become ready within ${timeoutMs}ms\n${text.slice(-4000)}`);
}

async function telegram(token: string, method: string, body: JsonObject = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as JsonObject;
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      optionalString(payload, "description") ?? `${method} failed with HTTP ${response.status}`,
    );
  }
  return payload.result;
}

async function drainSutUpdates(sutToken: string) {
  const before = telegramResultObject(await telegram(sutToken, "getWebhookInfo"), "getWebhookInfo");
  const rawUpdates = await telegram(sutToken, "getUpdates", {
    allowed_updates: ["message", "edited_message"],
    timeout: 0,
  });
  if (!Array.isArray(rawUpdates)) {
    throw new Error("getUpdates returned an invalid payload.");
  }
  const updates = rawUpdates;
  if (updates.length) {
    const last = updates.at(-1);
    if (
      last &&
      typeof last === "object" &&
      "update_id" in last &&
      typeof last.update_id === "number"
    ) {
      await telegram(sutToken, "getUpdates", { offset: last.update_id + 1, timeout: 0 });
    }
  }
  const after = telegramResultObject(await telegram(sutToken, "getWebhookInfo"), "getWebhookInfo");
  return {
    drained: updates.length,
    pendingAfter:
      typeof after.pending_update_count === "number" ? after.pending_update_count : undefined,
    pendingBefore:
      typeof before.pending_update_count === "number" ? before.pending_update_count : undefined,
    webhookUrlSet: typeof before.url === "string" && before.url.length > 0,
  };
}

async function sutIdentity(sutToken: string) {
  const result = telegramResultObject(await telegram(sutToken, "getMe"), "getMe");
  const username = requireString(result, "username").replace(/^@/u, "");
  return { id: requireString(result, "id"), username };
}

function telegramResultObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload.`);
  }
  return value as JsonObject;
}

function writeSutConfig(params: {
  gatewayPort: number;
  groupId: string;
  mockPort: number;
  outputDir: string;
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
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": { params: { openaiWsWarmup: false, transport: "sse" } } },
      },
      list: [
        {
          default: true,
          id: "main",
          model: { primary: "openai/gpt-5.5" },
          name: "Main",
          workspace,
        },
      ],
    },
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
        replyToMode: "first",
      },
    },
    gateway: { auth: { mode: "none" }, bind: "loopback", mode: "local", port: params.gatewayPort },
    messages: { groupChat: { visibleReplies: "automatic" } },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          baseUrl: `http://127.0.0.1:${params.mockPort}/v1`,
          models: [
            { api: "openai-responses", contextWindow: 128000, id: "gpt-5.5", name: "gpt-5.5" },
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

async function startLocalSut(params: {
  gatewayPort: number;
  groupId: string;
  mockResponseText: string;
  mockPort: number;
  outputDir: string;
  sutToken: string;
  testerId: string;
  repoRoot: string;
}) {
  const drained = await drainSutUpdates(params.sutToken);
  const config = writeSutConfig(params);
  const requestLog = path.join(params.outputDir, "mock-openai-requests.ndjson");
  const mock = spawnLogged("node", ["scripts/e2e/mock-openai-server.mjs"], {
    cwd: params.repoRoot,
    env: mockServerEnv({ ...params, requestLog }),
  });
  await waitForOutput(
    mock.child,
    /mock-openai listening/u,
    () => mock.output,
    "mock-openai",
    10_000,
  );
  const gateway = spawnLogged(
    "pnpm",
    ["openclaw", "gateway", "--port", String(params.gatewayPort)],
    {
      cwd: params.repoRoot,
      env: gatewayEnv({ ...config, sutToken: params.sutToken }),
    },
  );
  await waitForOutput(gateway.child, /\[gateway\] ready/u, () => gateway.output, "gateway", 60_000);
  return {
    ...config,
    drained,
    gateway: gateway.child,
    get gatewayLog() {
      return gateway.output;
    },
    mock: mock.child,
    get mockLog() {
      return mock.output;
    },
    requestLog,
  };
}

async function startLocalSutDaemon(params: {
  gatewayPort: number;
  groupId: string;
  mockResponseText: string;
  mockPort: number;
  outputDir: string;
  sutToken: string;
  testerId: string;
  repoRoot: string;
}) {
  const drained = await drainSutUpdates(params.sutToken);
  const config = writeSutConfig(params);
  const requestLog = path.join(params.outputDir, "mock-openai-requests.ndjson");
  const mockLog = path.join(params.outputDir, "mock-openai.log");
  const gatewayLog = path.join(params.outputDir, "gateway.log");
  const mockPid = spawnDaemon({
    command: "node",
    args: ["scripts/e2e/mock-openai-server.mjs"],
    cwd: params.repoRoot,
    env: mockServerEnv({ ...params, requestLog }),
    logPath: mockLog,
  });
  if (!mockPid) {
    throw new Error("mock-openai did not start.");
  }
  await waitForLog(mockLog, /mock-openai listening/u, "mock-openai", 10_000);

  const gatewayPid = spawnDaemon({
    command: "pnpm",
    args: ["openclaw", "gateway", "--port", String(params.gatewayPort)],
    cwd: params.repoRoot,
    env: gatewayEnv({ ...config, sutToken: params.sutToken }),
    logPath: gatewayLog,
  });
  if (!gatewayPid) {
    throw new Error("gateway did not start.");
  }
  await waitForLog(gatewayLog, /\[gateway\] ready/u, "gateway", 60_000);
  return {
    ...config,
    drained,
    gatewayLog,
    gatewayPid,
    mockLog,
    mockPid,
    requestLog,
  };
}

function extractLeaseId(output: string) {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}

async function warmupCrabbox(opts: Options, root: string) {
  const result = await runCommand({
    command: opts.crabboxBin,
    args: [
      "warmup",
      "--provider",
      opts.provider,
      "--target",
      opts.target,
      "--desktop",
      "--browser",
      "--class",
      opts.crabboxClass,
      "--idle-timeout",
      opts.idleTimeout,
      "--ttl",
      opts.ttl,
    ],
    cwd: root,
    stdio: "inherit",
  });
  const leaseId = extractLeaseId(`${result.stdout}\n${result.stderr}`);
  if (!leaseId) {
    throw new Error("Crabbox warmup did not print a lease id.");
  }
  return leaseId;
}

async function createMotionPreview(params: {
  motionGifPath: string;
  motionVideoPath: string;
  opts: Options;
  root: string;
  videoPath: string;
}) {
  const preview = await runCommand({
    command: params.opts.crabboxBin,
    args: [
      "media",
      "preview",
      "--input",
      params.videoPath,
      "--output",
      params.motionGifPath,
      "--fps",
      String(params.opts.previewFps),
      "--width",
      String(params.opts.previewWidth),
      "--trimmed-video-output",
      params.motionVideoPath,
      "--json",
    ],
    cwd: params.root,
    stdio: "inherit",
  });
  return JSON.parse(preview.stdout) as JsonObject;
}

function previewCrop(opts: Options) {
  return opts.previewCrop === "telegram-window"
    ? { ...TELEGRAM_PROOF_VIEW, cropWidth: opts.previewCropWidth }
    : undefined;
}

async function createCroppedMotionPreview(params: {
  crop: typeof TELEGRAM_PROOF_VIEW;
  croppedGifPath: string;
  croppedVideoPath: string;
  opts: Options;
  root: string;
  videoPath: string;
}) {
  const crop = `crop=${params.crop.width}:${params.crop.height}:${params.crop.x}:${params.crop.y}`;
  const scale = `scale=${params.crop.cropWidth}:-2:flags=lanczos`;
  await runCommand({
    command: "ffmpeg",
    args: [
      "-y",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      params.videoPath,
      "-vf",
      `${crop},${scale}`,
      "-pix_fmt",
      "yuv420p",
      params.croppedVideoPath,
    ],
    cwd: params.root,
    stdio: "inherit",
  });
  await runCommand({
    command: "ffmpeg",
    args: [
      "-y",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      params.videoPath,
      "-filter_complex",
      `${crop},fps=${params.opts.previewFps},${scale},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      params.croppedGifPath,
    ],
    cwd: params.root,
    stdio: "inherit",
  });
  return {
    crop,
    fps: params.opts.previewFps,
    outputWidth: params.crop.cropWidth,
  };
}

async function inspectCrabbox(opts: Options, root: string, leaseId: string) {
  const result = await runCommand({
    command: opts.crabboxBin,
    args: [
      "inspect",
      "--provider",
      opts.provider,
      "--target",
      opts.target,
      "--id",
      leaseId,
      "--json",
    ],
    cwd: root,
  });
  return JSON.parse(result.stdout) as CrabboxInspect;
}

function sshArgs(inspect: CrabboxInspect) {
  if (!inspect.host || !inspect.sshKey || !inspect.sshUser) {
    throw new Error("Crabbox inspect output is missing SSH details.");
  }
  return {
    base: [
      "-i",
      inspect.sshKey,
      "-p",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
    ],
    scpBase: [
      "-i",
      inspect.sshKey,
      "-P",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
    ],
    target: `${inspect.sshUser}@${inspect.host}`,
  };
}

async function scpToRemote(root: string, inspect: CrabboxInspect, local: string, remote: string) {
  const ssh = sshArgs(inspect);
  await runCommand({
    command: "scp",
    args: [...ssh.scpBase, local, `${ssh.target}:${remote}`],
    cwd: root,
    stdio: "inherit",
  });
}

async function scpFromRemote(root: string, inspect: CrabboxInspect, remote: string, local: string) {
  const ssh = sshArgs(inspect);
  await runCommand({
    command: "scp",
    args: [...ssh.scpBase, `${ssh.target}:${remote}`, local],
    cwd: root,
    stdio: "inherit",
  });
}

async function sshRun(root: string, inspect: CrabboxInspect, remoteCommand: string) {
  const ssh = sshArgs(inspect);
  return await runCommand({
    command: "ssh",
    args: [...ssh.base, ssh.target, remoteCommand],
    cwd: root,
    stdio: "inherit",
  });
}

function renderRemoteSetup(params: { tdlibSha256?: string; tdlibUrl?: string }) {
  const tdlibSha256 = JSON.stringify(params.tdlibSha256 ?? "");
  const tdlibUrl = JSON.stringify(params.tdlibUrl ?? "");
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
tdlib_sha256=${tdlibSha256}
tdlib_url=${tdlibUrl}
mkdir -p "$root"
tar -xzf "$root/state.tgz" -C "$root"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl git cmake g++ make zlib1g-dev libssl-dev python3 ffmpeg scrot xz-utils tar wmctrl xdotool x11-utils libopengl0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xinerama0 libxkbcommon-x11-0 >/tmp/openclaw-telegram-apt.log
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 127
fi
if [ ! -x "$root/Telegram/Telegram" ]; then
  curl -fL https://telegram.org/dl/desktop/linux -o "$root/telegram.tar.xz"
  tar -xJf "$root/telegram.tar.xz" -C "$root"
fi
if ! ldconfig -p | grep -q libtdjson.so; then
  if [ -n "$tdlib_url" ]; then
    curl -fL "$tdlib_url" -o "$root/tdlib-linux.tgz"
    if [ -z "$tdlib_sha256" ]; then
      curl -fL "$tdlib_url.sha256" -o "$root/tdlib-linux.tgz.sha256"
      tdlib_sha256="$(awk '{print $1; exit}' "$root/tdlib-linux.tgz.sha256")"
    fi
    printf '%s  %s\\n' "$tdlib_sha256" "$root/tdlib-linux.tgz" | sha256sum -c -
    mkdir -p "$root/tdlib-linux"
    tar -xzf "$root/tdlib-linux.tgz" -C "$root/tdlib-linux"
    lib="$(find "$root/tdlib-linux" -name libtdjson.so -type f | head -n 1)"
    test -n "$lib"
    sudo install -m 0755 "$lib" /usr/local/lib/libtdjson.so
  else
    rm -rf "$root/td" "$root/td-build"
    git clone --depth 1 --branch v1.8.0 https://github.com/tdlib/td.git "$root/td"
    cmake -S "$root/td" -B "$root/td-build" -DCMAKE_BUILD_TYPE=Release -DTD_ENABLE_JNI=OFF
    cmake --build "$root/td-build" --target tdjson -j "$(nproc)"
    sudo cmake --install "$root/td-build"
  fi
  sudo ldconfig
fi
TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" status --json --timeout-ms 60000 >"$root/status.json"
`;
}

function renderLaunchDesktop() {
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export DISPLAY="\${DISPLAY:-:99}"
pkill -f "$root/Telegram/Telegram" >/dev/null 2>&1 || true
nohup "$root/Telegram/Telegram" -workdir "$root/desktop" >"$root/telegram-desktop.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" >/dev/null 2>&1; then
  cat "$root/telegram-desktop.log" >&2
  exit 1
fi
if ! wmctrl -l | grep -i telegram >/dev/null 2>&1; then
  cat "$root/telegram-desktop.log" >&2
  exit 1
fi
`;
}

function renderSelectDesktopChat(params: { chatTitle: string }) {
  return `#!/usr/bin/env bash
set -euo pipefail
chat_title=${JSON.stringify(params.chatTitle)}
export DISPLAY="\${DISPLAY:-:99}"
win="$(wmctrl -l | awk 'tolower($0) ~ /telegram/ {print $1; exit}')"
test -n "$win"
left=520
top=170
xdotool windowactivate --sync "$win"
xdotool windowsize "$win" 980 720
xdotool windowmove "$win" "$left" "$top"
sleep 1
xdotool mousemove "$((left + 180))" "$((top + 50))" click 1
xdotool key ctrl+a BackSpace
xdotool type --delay 5 -- "$chat_title"
sleep 2
xdotool mousemove "$((left + 150))" "$((top + 120))" click 1
sleep 1
`;
}

function renderRemoteProbe(params: {
  expect: string[];
  outputPath?: string;
  sutUsername: string;
  text: string;
  timeoutMs: number;
}) {
  const args = [
    "probe",
    "--text",
    params.text,
    "--timeout-ms",
    String(params.timeoutMs),
    "--output",
    params.outputPath ?? `${REMOTE_ROOT}/probe.json`,
    "--json",
  ];
  for (const expected of params.expect) {
    args.push("--expect", expected);
  }
  const escapedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver"
export TELEGRAM_USER_DRIVER_SUT_USERNAME=${JSON.stringify(params.sutUsername)}
python3 "$root/user-driver.py" ${escapedArgs}
`;
}

async function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o700);
}

function requireUserDriverScript(opts: Options) {
  const userDriverScript = expandHome(opts.userDriverScript);
  if (!fs.existsSync(userDriverScript)) {
    throw new Error(`Missing user driver script: ${opts.userDriverScript}`);
  }
  return userDriverScript;
}

async function prepareRemoteState(params: { localRoot: string; opts: Options; root: string }) {
  const stateArchive = path.join(params.localRoot, "remote-state.tgz");
  const userDriverScript = requireUserDriverScript(params.opts);
  await runCommand({
    command: "cp",
    args: [userDriverScript, path.join(params.localRoot, "user-driver.py")],
    cwd: params.root,
  });
  await runCommand({
    command: "tar",
    args: [
      "-C",
      params.localRoot,
      "-czf",
      stateArchive,
      "user-driver",
      "desktop",
      "user-driver.py",
    ],
    cwd: params.root,
  });
  return stateArchive;
}

async function leaseCredential(params: { localRoot: string; opts: Options; root: string }) {
  const userDriverDir = path.join(params.localRoot, "user-driver");
  const desktopWorkdir = path.join(params.localRoot, "desktop");
  const leaseFile = path.join(params.localRoot, "lease.json");
  const payloadFile = path.join(params.localRoot, "payload.json");
  const args = [
    CREDENTIAL_SCRIPT,
    "lease-restore",
    "--user-driver-dir",
    userDriverDir,
    "--desktop-workdir",
    desktopWorkdir,
    "--lease-file",
    leaseFile,
    "--payload-output",
    payloadFile,
  ];
  if (params.opts.envFile) {
    args.push("--env-file", params.opts.envFile);
  }
  const result = await runCommand({
    command: "node",
    args: ["--import", "tsx", ...args],
    cwd: params.root,
    stdio: "inherit",
  });
  const acquired = JSON.parse(result.stdout || "{}") as JsonObject;
  const payload = readJsonFile(payloadFile);
  return {
    acquired,
    desktopWorkdir,
    groupId: requireString(payload, "groupId"),
    leaseFile,
    payloadFile,
    sutToken: requireString(payload, "sutToken"),
    testerUserId: requireString(payload, "testerUserId"),
    testerUsername: requireString(payload, "testerUsername"),
    userDriverDir,
  };
}

async function releaseCredential(root: string, opts: Options, leaseFile: string) {
  if (!fs.existsSync(leaseFile)) {
    return;
  }
  const args = [CREDENTIAL_SCRIPT, "release", "--lease-file", leaseFile];
  if (opts.envFile) {
    args.push("--env-file", opts.envFile);
  }
  await runCommand({
    command: "node",
    args: ["--import", "tsx", ...args],
    cwd: root,
    stdio: "inherit",
  });
}

async function stopCrabbox(root: string, opts: Options, leaseId: string) {
  await runCommand({
    command: opts.crabboxBin,
    args: ["stop", "--provider", opts.provider, leaseId],
    cwd: root,
    stdio: "inherit",
  });
}

function buildTargetText(text: string, sutUsername: string) {
  if (!text.startsWith("/")) {
    return text.replaceAll("{sut}", sutUsername);
  }
  if (/^\/\S+@\w+/u.test(text)) {
    return text;
  }
  const [command, ...rest] = text.split(/\s+/u);
  return [`${command}@${sutUsername}`, ...rest].join(" ").trim();
}

function summarizeProbe(probePath: string) {
  const probe = readJsonFile(probePath);
  const reply = probe.reply;
  const sent = probe.sent;
  const messageId = (value: unknown) => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    if ("messageId" in value) {
      return value.messageId;
    }
    if ("id" in value) {
      return value.id;
    }
    return undefined;
  };
  return {
    ok: probe.ok === true,
    replyMessageId: messageId(reply),
    sentMessageId: messageId(sent),
  };
}

function writeReport(params: {
  croppedMotionGifPath?: string;
  croppedMotionVideoPath?: string;
  motionGifPath?: string;
  motionVideoPath?: string;
  outputDir: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
  videoPath?: string;
}) {
  const reportPath = path.join(params.outputDir, "telegram-user-crabbox-proof.md");
  fs.writeFileSync(
    reportPath,
    [
      "# Telegram User Crabbox Proof",
      "",
      `Status: ${params.status}`,
      `Summary: ${path.basename(params.summaryPath)}`,
      params.videoPath ? `Video: ${path.basename(params.videoPath)}` : "Video: missing",
      params.motionVideoPath
        ? `Motion video: ${path.basename(params.motionVideoPath)}`
        : "Motion video: missing",
      params.motionGifPath
        ? `Motion GIF: ${path.basename(params.motionGifPath)}`
        : "Motion GIF: missing",
      params.croppedMotionVideoPath
        ? `Cropped motion video: ${path.basename(params.croppedMotionVideoPath)}`
        : undefined,
      params.croppedMotionGifPath
        ? `Cropped motion GIF: ${path.basename(params.croppedMotionGifPath)}`
        : undefined,
      params.screenshotPath
        ? `Screenshot: ${path.basename(params.screenshotPath)}`
        : "Screenshot: missing",
      "",
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
  );
  return reportPath;
}

function sessionPath(root: string, opts: Options, outputDir: string) {
  return opts.sessionFile
    ? resolveRepoPath(root, opts.sessionFile)
    : path.join(outputDir, "session.json");
}

function writeSession(pathname: string, session: SessionFile) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(pathname, 0o600);
}

function readSession(root: string, opts: Options, outputDir: string) {
  const pathname = sessionPath(root, opts, outputDir);
  if (!fs.existsSync(pathname)) {
    throw new Error(`Missing session file: ${path.relative(root, pathname)}`);
  }
  const session = readJsonFile(pathname) as SessionFile;
  if (session.command !== "telegram-user-crabbox-session") {
    throw new Error(`Invalid Telegram Crabbox session file: ${path.relative(root, pathname)}`);
  }
  return {
    path: pathname,
    session,
  };
}

async function writeRemoteSessionScripts(params: {
  inspect: CrabboxInspect;
  localRoot: string;
  opts: Options;
  root: string;
  stateArchive: string;
  sutUsername: string;
}) {
  const setupScript = path.join(params.localRoot, "remote-setup.sh");
  const launchScript = path.join(params.localRoot, "launch-desktop.sh");
  const selectChatScript = path.join(params.localRoot, "select-desktop-chat.sh");
  await writeExecutable(
    setupScript,
    renderRemoteSetup({ tdlibSha256: params.opts.tdlibSha256, tdlibUrl: params.opts.tdlibUrl }),
  );
  await writeExecutable(launchScript, renderLaunchDesktop());
  await writeExecutable(
    selectChatScript,
    renderSelectDesktopChat({ chatTitle: params.opts.desktopChatTitle }),
  );

  await sshRun(params.root, params.inspect, `rm -rf ${REMOTE_ROOT} && mkdir -p ${REMOTE_ROOT}`);
  await scpToRemote(params.root, params.inspect, params.stateArchive, `${REMOTE_ROOT}/state.tgz`);
  await scpToRemote(params.root, params.inspect, setupScript, `${REMOTE_ROOT}/remote-setup.sh`);
  await scpToRemote(params.root, params.inspect, launchScript, `${REMOTE_ROOT}/launch-desktop.sh`);
  await scpToRemote(
    params.root,
    params.inspect,
    selectChatScript,
    `${REMOTE_ROOT}/select-desktop-chat.sh`,
  );
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/remote-setup.sh`);
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/launch-desktop.sh`);
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/select-desktop-chat.sh`);
  await sshRun(
    params.root,
    params.inspect,
    `cat >${REMOTE_ROOT}/env.sh <<'EOF'
export TELEGRAM_USER_DRIVER_STATE_DIR=${REMOTE_ROOT}/user-driver
export TELEGRAM_USER_DRIVER_SUT_USERNAME=${params.sutUsername}
EOF
`,
  );
}

async function startRemoteRecording(root: string, inspect: CrabboxInspect, opts: Options) {
  const command = `set -euo pipefail
export DISPLAY="\${DISPLAY:-:99}"
root=${REMOTE_ROOT}
video="$root/session.mp4"
log="$root/ffmpeg.log"
pid_file="$root/ffmpeg.pid"
rm -f "$video" "$log" "$pid_file"
size="$(xdpyinfo | awk '/dimensions:/ {size=$2} END {if (!size) exit 1; print size}')"
nohup ffmpeg -y -hide_banner -loglevel warning -f x11grab -framerate ${opts.recordFps} -video_size "$size" -i "$DISPLAY" -pix_fmt yuv420p "$video" >"$log" 2>&1 &
echo $! >"$pid_file"`;
  await sshRun(root, inspect, command);
  return {
    log: `${REMOTE_ROOT}/ffmpeg.log`,
    pidFile: `${REMOTE_ROOT}/ffmpeg.pid`,
    remoteVideo: `${REMOTE_ROOT}/session.mp4`,
  };
}

async function stopRemoteRecording(root: string, inspect: CrabboxInspect, session: SessionFile) {
  await sshRun(
    root,
    inspect,
    `set -euo pipefail
pid_file=${JSON.stringify(session.recorder.pidFile)}
if [ -s "$pid_file" ]; then
  pid="$(cat "$pid_file")"
  kill -INT "$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" >/dev/null 2>&1 || exit 0
    sleep 0.5
  done
  kill -TERM "$pid" >/dev/null 2>&1 || true
fi`,
  );
}

async function startSession(root: string, opts: Options, outputDir: string) {
  const localRoot = path.join(outputDir, ".session");
  fs.rmSync(localRoot, { force: true, recursive: true });
  fs.mkdirSync(localRoot, { mode: 0o700, recursive: true });

  const convexEnvFile = expandHome(opts.envFile ?? DEFAULT_CONVEX_ENV_FILE);
  const hasConvexEnv =
    trimToValue(process.env.OPENCLAW_QA_CONVEX_SITE_URL) &&
    trimToValue(process.env.OPENCLAW_QA_CONVEX_SECRET_CI);
  if (!hasConvexEnv && !fs.existsSync(convexEnvFile)) {
    throw new Error(`Missing Convex env file: ${opts.envFile ?? DEFAULT_CONVEX_ENV_FILE}`);
  }
  await runCommand({ command: opts.crabboxBin, args: ["--version"], cwd: root });
  if (opts.dryRun) {
    return {
      command: "telegram-user-crabbox-session",
      crabboxClass: opts.crabboxClass,
      outputDir,
      provider: opts.provider,
      target: opts.target,
      tdlibSha256: opts.tdlibSha256,
      tdlibUrl: opts.tdlibUrl,
    };
  }

  requireUserDriverScript(opts);
  const credential = await leaseCredential({ localRoot, opts, root });
  const sut = opts.sutUsername
    ? { id: "", username: opts.sutUsername }
    : await sutIdentity(credential.sutToken);
  const stateArchive = await prepareRemoteState({ localRoot, opts, root });
  let leaseId = opts.leaseId;
  let createdLease = false;
  if (!leaseId) {
    leaseId = await warmupCrabbox(opts, root);
    createdLease = true;
  }
  const inspect = await inspectCrabbox(opts, root, leaseId);
  let localSut: Awaited<ReturnType<typeof startLocalSutDaemon>> | undefined;
  try {
    await writeRemoteSessionScripts({
      inspect,
      localRoot,
      opts,
      root,
      stateArchive,
      sutUsername: sut.username,
    });
    localSut = await startLocalSutDaemon({
      gatewayPort: opts.gatewayPort,
      groupId: credential.groupId,
      mockResponseText: opts.mockResponseText,
      mockPort: opts.mockPort,
      outputDir,
      repoRoot: root,
      sutToken: credential.sutToken,
      testerId: credential.testerUserId,
    });
    const recorder = await startRemoteRecording(root, inspect, opts);
    const session: SessionFile = {
      command: "telegram-user-crabbox-session",
      createdAt: new Date().toISOString(),
      crabbox: {
        class: opts.crabboxClass,
        createdLease,
        id: leaseId,
        inspect,
        provider: opts.provider,
        target: opts.target,
      },
      credential: {
        groupId: credential.groupId,
        leaseFile: credential.leaseFile,
        sutUsername: sut.username,
        testerUserId: credential.testerUserId,
        testerUsername: credential.testerUsername,
      },
      localRoot,
      localSut,
      outputDir,
      recorder,
      remoteRoot: REMOTE_ROOT,
    };
    const pathname = sessionPath(root, opts, outputDir);
    writeSession(pathname, session);
    return {
      session: path.relative(root, pathname),
      status: "pass",
      telegram: {
        groupId: credential.groupId,
        sutUsername: sut.username,
        testerUserId: credential.testerUserId,
        testerUsername: credential.testerUsername,
      },
      webvnc: `${opts.crabboxBin} webvnc --provider ${opts.provider} --target ${opts.target} --id ${leaseId} --open`,
      commands: {
        send: `pnpm qa:telegram-user:crabbox -- send --session ${path.relative(root, pathname)} --text '/status'`,
        view: `pnpm qa:telegram-user:crabbox -- view --session ${path.relative(root, pathname)} --message-id <message-id>`,
        run: `pnpm qa:telegram-user:crabbox -- run --session ${path.relative(root, pathname)} -- bash -lc 'source ${REMOTE_ROOT}/env.sh && python3 ${REMOTE_ROOT}/user-driver.py transcript --limit 20 --json'`,
        finish: `pnpm qa:telegram-user:crabbox -- finish --session ${path.relative(root, pathname)} --preview-crop telegram-window`,
      },
    };
  } catch (error) {
    killPidTree(localSut?.gatewayPid);
    killPidTree(localSut?.mockPid);
    await releaseCredential(root, opts, credential.leaseFile).catch(() => {});
    if (leaseId && createdLease) {
      await stopCrabbox(root, opts, leaseId).catch(() => {});
    }
    throw error;
  }
}

async function sendSessionProbe(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const targetText = buildTargetText(opts.text, session.credential.sutUsername);
  const remoteProbe = `${REMOTE_ROOT}/probe-${stamp}.json`;
  const probeScript = path.join(session.localRoot, `remote-probe-${stamp}.sh`);
  await writeExecutable(
    probeScript,
    renderRemoteProbe({
      expect: opts.expect,
      outputPath: remoteProbe,
      sutUsername: session.credential.sutUsername,
      text: targetText,
      timeoutMs: opts.timeoutMs,
    }),
  );
  await scpToRemote(root, session.crabbox.inspect, probeScript, `${REMOTE_ROOT}/remote-probe.sh`);
  await sshRun(root, session.crabbox.inspect, `bash ${REMOTE_ROOT}/remote-probe.sh`);
  const localProbe = path.join(session.outputDir, `probe-${stamp}.json`);
  await scpFromRemote(root, session.crabbox.inspect, remoteProbe, localProbe);
  return {
    probe: path.relative(root, localProbe),
    status: "pass",
    summary: summarizeProbe(localProbe),
    text: targetText,
  };
}

async function runSessionCommand(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const command = opts.remoteCommand.map(shellQuote).join(" ");
  const result = await sshRun(root, session.crabbox.inspect, command);
  const logPath = path.join(
    session.outputDir,
    `remote-command-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`,
  );
  fs.writeFileSync(logPath, `${result.stdout}${result.stderr}`);
  return { command: opts.remoteCommand, log: path.relative(root, logPath), status: "pass" };
}

async function screenshotSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const screenshotPath = path.join(
    session.outputDir,
    `telegram-user-crabbox-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`,
  );
  await runCommand({
    command: opts.crabboxBin,
    args: [
      "screenshot",
      "--provider",
      session.crabbox.provider,
      "--target",
      session.crabbox.target,
      "--id",
      session.crabbox.id,
      "--output",
      screenshotPath,
    ],
    cwd: root,
    stdio: "inherit",
  });
  return { screenshot: path.relative(root, screenshotPath), status: "pass" };
}

async function statusSession(root: string, opts: Options, outputDir: string) {
  const { path: pathname, session } = readSession(root, opts, outputDir);
  const inspect = await inspectCrabbox(opts, root, session.crabbox.id);
  return {
    crabbox: {
      id: session.crabbox.id,
      slug: inspect.slug,
      state: inspect.state,
    },
    session: path.relative(root, pathname),
    status: "pass",
    webvnc: `${opts.crabboxBin} webvnc --provider ${session.crabbox.provider} --target ${session.crabbox.target} --id ${session.crabbox.id} --open`,
  };
}

function telegramPrivatePostLink(groupId: string, messageId: string) {
  if (!/^-100\d+$/u.test(groupId)) {
    throw new Error(`Telegram privatepost links require a -100 group id, got ${groupId}.`);
  }
  return `tg://privatepost?channel=${groupId.slice(4)}&post=${messageId}`;
}

function renderProofViewCommand(link: string) {
  return `set -euo pipefail
export DISPLAY="\${DISPLAY:-:99}"
root=${REMOTE_ROOT}
win="$(wmctrl -lxG | awk 'tolower($0) ~ /telegramdesktop/ {print $1; exit}')"
if [ -z "$win" ]; then
  echo "Telegram Desktop window not found." >&2
  exit 1
fi
wmctrl -ir "$win" -b remove,maximized_vert,maximized_horz,fullscreen
wmctrl -ir "$win" -e 0,${TELEGRAM_PROOF_VIEW.x},${TELEGRAM_PROOF_VIEW.y},${TELEGRAM_PROOF_VIEW.width},${TELEGRAM_PROOF_VIEW.height}
telegram="$root/Telegram/Telegram"
test -x "$telegram"
set +e
timeout 5 "$telegram" -workdir "$root/desktop" ${shellQuote(link)}
status="$?"
set -e
if [ "$status" -ne 0 ] && [ "$status" -ne 124 ]; then
  exit "$status"
fi
sleep 1
wmctrl -lxG | awk 'tolower($0) ~ /telegramdesktop/'`;
}

async function viewSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const messageId = opts.messageId;
  if (!messageId) {
    throw new Error("view requires --message-id.");
  }
  const link = telegramPrivatePostLink(session.credential.groupId, messageId);
  const result = await sshRun(root, session.crabbox.inspect, renderProofViewCommand(link));
  const logPath = path.join(
    session.outputDir,
    `proof-view-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`,
  );
  fs.writeFileSync(logPath, `${result.stdout}${result.stderr}`);
  return {
    geometry: TELEGRAM_PROOF_VIEW,
    link,
    log: path.relative(root, logPath),
    status: "pass",
  };
}

async function finishSession(root: string, opts: Options, outputDir: string) {
  const { path: pathname, session } = readSession(root, opts, outputDir);
  const summary: JsonObject = {
    artifacts: {},
    finishedAt: new Date().toISOString(),
    session: path.relative(root, pathname),
    startedAt: session.createdAt,
    status: "fail",
  };
  const videoPath = path.join(session.outputDir, "telegram-user-crabbox-session.mp4");
  const motionVideoPath = path.join(session.outputDir, "telegram-user-crabbox-session-motion.mp4");
  const motionGifPath = path.join(session.outputDir, "telegram-user-crabbox-session-motion.gif");
  const croppedMotionVideoPath = path.join(
    session.outputDir,
    "telegram-user-crabbox-session-motion-telegram-window.mp4",
  );
  const croppedMotionGifPath = path.join(
    session.outputDir,
    "telegram-user-crabbox-session-motion-telegram-window.gif",
  );
  const screenshotPath = path.join(session.outputDir, "telegram-user-crabbox-session.png");
  const desktopLogPath = path.join(session.outputDir, "telegram-desktop.log");
  const statusPath = path.join(session.outputDir, "status.json");
  const ffmpegLogPath = path.join(session.outputDir, "ffmpeg.log");
  const crop = previewCrop(opts);
  try {
    await stopRemoteRecording(root, session.crabbox.inspect, session);
    await scpFromRemote(root, session.crabbox.inspect, session.recorder.remoteVideo, videoPath);
    await scpFromRemote(
      root,
      session.crabbox.inspect,
      `${REMOTE_ROOT}/telegram-desktop.log`,
      desktopLogPath,
    ).catch(() => {});
    await scpFromRemote(
      root,
      session.crabbox.inspect,
      `${REMOTE_ROOT}/status.json`,
      statusPath,
    ).catch(() => {});
    await scpFromRemote(root, session.crabbox.inspect, session.recorder.log, ffmpegLogPath).catch(
      () => {},
    );
    summary.mediaPreview = await createMotionPreview({
      motionGifPath,
      motionVideoPath,
      opts,
      root,
      videoPath,
    });
    if (crop) {
      summary.croppedMediaPreview = await createCroppedMotionPreview({
        crop,
        croppedGifPath: croppedMotionGifPath,
        croppedVideoPath: croppedMotionVideoPath,
        opts,
        root,
        videoPath: motionVideoPath,
      });
    }
    await runCommand({
      command: opts.crabboxBin,
      args: [
        "screenshot",
        "--provider",
        session.crabbox.provider,
        "--target",
        session.crabbox.target,
        "--id",
        session.crabbox.id,
        "--output",
        screenshotPath,
      ],
      cwd: root,
      stdio: "inherit",
    });
    summary.artifacts = {
      desktopLog: path.relative(root, desktopLogPath),
      ffmpegLog: path.relative(root, ffmpegLogPath),
      previewGif: path.relative(root, motionGifPath),
      ...(crop
        ? {
            previewGifCropped: path.relative(root, croppedMotionGifPath),
            trimmedVideoCropped: path.relative(root, croppedMotionVideoPath),
          }
        : {}),
      screenshot: path.relative(root, screenshotPath),
      status: path.relative(root, statusPath),
      trimmedVideo: path.relative(root, motionVideoPath),
      video: path.relative(root, videoPath),
    };
    summary.status = "pass";
  } finally {
    killPidTree(session.localSut.gatewayPid);
    killPidTree(session.localSut.mockPid);
    await releaseCredential(root, opts, session.credential.leaseFile).catch((error: unknown) => {
      summary.credentialReleaseError = error instanceof Error ? error.message : String(error);
    });
    if (session.crabbox.createdLease && !opts.keepBox) {
      await stopCrabbox(root, opts, session.crabbox.id).catch((error: unknown) => {
        summary.crabboxStopError = error instanceof Error ? error.message : String(error);
      });
    }
    if (opts.keepBox) {
      summary.keepBox = true;
      summary.webvnc = `${opts.crabboxBin} webvnc --provider ${session.crabbox.provider} --target ${session.crabbox.target} --id ${session.crabbox.id} --open`;
    }
    fs.rmSync(session.localRoot, { force: true, recursive: true });
    const summaryPath = path.join(session.outputDir, "telegram-user-crabbox-session-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const reportPath = writeReport({
      croppedMotionGifPath: crop ? croppedMotionGifPath : undefined,
      croppedMotionVideoPath: crop ? croppedMotionVideoPath : undefined,
      motionGifPath,
      motionVideoPath,
      outputDir: session.outputDir,
      screenshotPath,
      status: summary.status === "pass" ? "pass" : "fail",
      summaryPath,
      videoPath,
    });
    summary.report = path.relative(root, reportPath);
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, status: summary.status, summaryPath }, null, 2));
  }
  if (summary.status !== "pass") {
    process.exitCode = 1;
  }
}

async function publishSessionArtifacts(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const motionGifPath = path.join(session.outputDir, "telegram-user-crabbox-session-motion.gif");
  const croppedMotionGifPath = path.join(
    session.outputDir,
    "telegram-user-crabbox-session-motion-telegram-window.gif",
  );
  const publishGifPath = fs.existsSync(croppedMotionGifPath) ? croppedMotionGifPath : motionGifPath;
  const publishDir = opts.publishFullArtifacts
    ? session.outputDir
    : path.join(session.outputDir, "publish-gif-only");
  if (!opts.publishFullArtifacts) {
    if (!fs.existsSync(publishGifPath)) {
      throw new Error(
        `Missing motion GIF. Run finish first: ${path.relative(root, motionGifPath)}`,
      );
    }
    fs.rmSync(publishDir, { force: true, recursive: true });
    fs.mkdirSync(publishDir, { recursive: true });
    fs.copyFileSync(
      publishGifPath,
      path.join(publishDir, "telegram-user-crabbox-session-motion.gif"),
    );
  }
  await runCommand({
    command: opts.crabboxBin,
    args: [
      "artifacts",
      "publish",
      "--pr",
      String(opts.publishPr),
      "--repo",
      opts.publishRepo,
      "--dir",
      publishDir,
      "--summary",
      opts.publishSummary ??
        (opts.publishFullArtifacts
          ? "Telegram real-user Crabbox session artifacts"
          : "Telegram real-user Crabbox session motion GIF"),
      "--template",
      "openclaw",
      ...(opts.dryRun ? ["--dry-run"] : []),
    ],
    cwd: root,
    stdio: "inherit",
  });
  return {
    artifactMode: opts.publishFullArtifacts
      ? "full"
      : publishGifPath === croppedMotionGifPath
        ? "gif-only-cropped"
        : "gif-only",
    publishDir: path.relative(root, publishDir),
    status: "pass",
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const outputDir = resolveRepoPath(root, opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  opts.outputDir = outputDir;

  if (opts.command === "start") {
    console.log(JSON.stringify(await startSession(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "send") {
    console.log(JSON.stringify(await sendSessionProbe(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "run") {
    console.log(JSON.stringify(await runSessionCommand(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "screenshot") {
    console.log(JSON.stringify(await screenshotSession(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "status") {
    console.log(JSON.stringify(await statusSession(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "view") {
    console.log(JSON.stringify(await viewSession(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "finish") {
    await finishSession(root, opts, outputDir);
    return;
  }
  if (opts.command === "publish") {
    console.log(JSON.stringify(await publishSessionArtifacts(root, opts, outputDir), null, 2));
    return;
  }

  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-crabbox-"));
  const summary: JsonObject = {
    artifacts: {},
    crabbox: { provider: opts.provider, target: opts.target },
    outputDir,
    startedAt: new Date().toISOString(),
    status: "fail",
  };

  let credential: Awaited<ReturnType<typeof leaseCredential>> | undefined;
  let leaseId = opts.leaseId;
  let createdLease = false;
  let localSut: LocalSut | undefined;

  try {
    const convexEnvFile = expandHome(opts.envFile ?? DEFAULT_CONVEX_ENV_FILE);
    const hasConvexEnv =
      trimToValue(process.env.OPENCLAW_QA_CONVEX_SITE_URL) &&
      trimToValue(process.env.OPENCLAW_QA_CONVEX_SECRET_CI);
    if (!hasConvexEnv && !fs.existsSync(convexEnvFile)) {
      throw new Error(`Missing Convex env file: ${opts.envFile ?? DEFAULT_CONVEX_ENV_FILE}`);
    }
    await runCommand({ command: opts.crabboxBin, args: ["--version"], cwd: root });
    if (opts.dryRun) {
      summary.status = "pass";
      summary.plan = {
        command: "telegram-user-crabbox-proof",
        crabboxClass: opts.crabboxClass,
        outputDir,
        provider: opts.provider,
        target: opts.target,
        tdlibSha256: opts.tdlibSha256,
        tdlibUrl: opts.tdlibUrl,
        text: opts.text,
      };
      return;
    }

    requireUserDriverScript(opts);
    credential = await leaseCredential({ localRoot, opts, root });
    const sut = opts.sutUsername
      ? { id: "", username: opts.sutUsername }
      : await sutIdentity(credential.sutToken);
    const targetText = buildTargetText(opts.text, sut.username);
    summary.telegram = {
      groupId: credential.groupId,
      sutUsername: sut.username,
      testerUserId: credential.testerUserId,
      testerUsername: credential.testerUsername,
      text: targetText,
    };

    const stateArchive = await prepareRemoteState({
      localRoot,
      opts,
      root,
    });
    if (!leaseId) {
      leaseId = await warmupCrabbox(opts, root);
      createdLease = true;
    }
    summary.crabbox = {
      createdLease,
      id: leaseId,
      provider: opts.provider,
      target: opts.target,
    };
    const inspect = await inspectCrabbox(opts, root, leaseId);
    summary.crabbox = {
      createdLease,
      id: leaseId,
      provider: opts.provider,
      slug: inspect.slug,
      state: inspect.state,
      target: opts.target,
    };

    const setupScript = path.join(localRoot, "remote-setup.sh");
    const launchScript = path.join(localRoot, "launch-desktop.sh");
    const selectChatScript = path.join(localRoot, "select-desktop-chat.sh");
    const probeScript = path.join(localRoot, "remote-probe.sh");
    await writeExecutable(
      setupScript,
      renderRemoteSetup({ tdlibSha256: opts.tdlibSha256, tdlibUrl: opts.tdlibUrl }),
    );
    await writeExecutable(launchScript, renderLaunchDesktop());
    await writeExecutable(
      selectChatScript,
      renderSelectDesktopChat({ chatTitle: opts.desktopChatTitle }),
    );
    await writeExecutable(
      probeScript,
      renderRemoteProbe({
        expect: opts.expect,
        sutUsername: sut.username,
        text: targetText,
        timeoutMs: opts.timeoutMs,
      }),
    );

    await sshRun(root, inspect, `rm -rf ${REMOTE_ROOT} && mkdir -p ${REMOTE_ROOT}`);
    await scpToRemote(root, inspect, stateArchive, `${REMOTE_ROOT}/state.tgz`);
    await scpToRemote(root, inspect, setupScript, `${REMOTE_ROOT}/remote-setup.sh`);
    await scpToRemote(root, inspect, launchScript, `${REMOTE_ROOT}/launch-desktop.sh`);
    await scpToRemote(root, inspect, selectChatScript, `${REMOTE_ROOT}/select-desktop-chat.sh`);
    await scpToRemote(root, inspect, probeScript, `${REMOTE_ROOT}/remote-probe.sh`);
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/remote-setup.sh`);

    const sutRuntime = await startLocalSut({
      gatewayPort: opts.gatewayPort,
      groupId: credential.groupId,
      mockResponseText: opts.mockResponseText,
      mockPort: opts.mockPort,
      outputDir,
      repoRoot: root,
      sutToken: credential.sutToken,
      testerId: credential.testerUserId,
    });
    localSut = sutRuntime;
    summary.localSut = {
      drained: sutRuntime.drained,
      gatewayPort: opts.gatewayPort,
      mockPort: opts.mockPort,
      requestLog: path.relative(root, sutRuntime.requestLog),
    };

    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/launch-desktop.sh`);
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/select-desktop-chat.sh`);
    const videoPath = path.join(outputDir, "telegram-user-crabbox-proof.mp4");
    const recording = spawn(
      opts.crabboxBin,
      [
        "artifacts",
        "video",
        "--provider",
        opts.provider,
        "--target",
        opts.target,
        "--id",
        leaseId,
        "--duration",
        `${opts.recordSeconds}s`,
        "--output",
        videoPath,
      ],
      { cwd: root, stdio: "inherit" },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/remote-probe.sh`);
    const recordCode = await new Promise<number | null>((resolve) => recording.on("exit", resolve));
    if (recordCode !== 0) {
      throw new Error(`Crabbox recording failed with exit code ${recordCode ?? "unknown"}.`);
    }
    const motionVideoPath = path.join(outputDir, "telegram-user-crabbox-proof-motion.mp4");
    const motionGifPath = path.join(outputDir, "telegram-user-crabbox-proof-motion.gif");
    summary.mediaPreview = await createMotionPreview({
      motionGifPath,
      motionVideoPath,
      opts,
      root,
      videoPath,
    });

    const screenshotPath = path.join(outputDir, "telegram-user-crabbox-proof.png");
    await runCommand({
      command: opts.crabboxBin,
      args: [
        "screenshot",
        "--provider",
        opts.provider,
        "--target",
        opts.target,
        "--id",
        leaseId,
        "--output",
        screenshotPath,
      ],
      cwd: root,
      stdio: "inherit",
    });
    const probePath = path.join(outputDir, "probe.json");
    const statusPath = path.join(outputDir, "status.json");
    const desktopLogPath = path.join(outputDir, "telegram-desktop.log");
    await scpFromRemote(root, inspect, `${REMOTE_ROOT}/probe.json`, probePath);
    await scpFromRemote(root, inspect, `${REMOTE_ROOT}/status.json`, statusPath);
    await scpFromRemote(root, inspect, `${REMOTE_ROOT}/telegram-desktop.log`, desktopLogPath);
    summary.artifacts = {
      desktopLog: path.relative(root, desktopLogPath),
      probe: path.relative(root, probePath),
      previewGif: path.relative(root, motionGifPath),
      screenshot: path.relative(root, screenshotPath),
      status: path.relative(root, statusPath),
      trimmedVideo: path.relative(root, motionVideoPath),
      video: path.relative(root, videoPath),
    };
    summary.probe = summarizeProbe(probePath);
    summary.status = "pass";
  } finally {
    killTree(localSut?.gateway);
    killTree(localSut?.mock);
    if (credential) {
      await releaseCredential(root, opts, credential.leaseFile).catch((error: unknown) => {
        summary.credentialReleaseError = error instanceof Error ? error.message : String(error);
      });
    }
    if (leaseId && createdLease && !opts.keepBox) {
      await stopCrabbox(root, opts, leaseId).catch((error: unknown) => {
        summary.crabboxStopError = error instanceof Error ? error.message : String(error);
      });
    }
    if (opts.keepBox && leaseId) {
      summary.keepBox = true;
      summary.webvnc = `${opts.crabboxBin} webvnc --provider ${opts.provider} --target ${opts.target} --id ${leaseId} --open`;
    }
    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(outputDir, "telegram-user-crabbox-proof-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const artifacts = summary.artifacts;
    const screenshotPath =
      artifacts &&
      typeof artifacts === "object" &&
      "screenshot" in artifacts &&
      typeof artifacts.screenshot === "string"
        ? path.join(root, artifacts.screenshot)
        : undefined;
    const motionGifPath =
      artifacts &&
      typeof artifacts === "object" &&
      "previewGif" in artifacts &&
      typeof artifacts.previewGif === "string"
        ? path.join(root, artifacts.previewGif)
        : undefined;
    const motionVideoPath =
      artifacts &&
      typeof artifacts === "object" &&
      "trimmedVideo" in artifacts &&
      typeof artifacts.trimmedVideo === "string"
        ? path.join(root, artifacts.trimmedVideo)
        : undefined;
    const videoPath =
      artifacts &&
      typeof artifacts === "object" &&
      "video" in artifacts &&
      typeof artifacts.video === "string"
        ? path.join(root, artifacts.video)
        : undefined;
    const reportPath = writeReport({
      motionGifPath,
      motionVideoPath,
      outputDir,
      screenshotPath,
      status: summary.status === "pass" ? "pass" : "fail",
      summaryPath,
      videoPath,
    });
    summary.report = path.relative(root, reportPath);
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    fs.rmSync(localRoot, { force: true, recursive: true });
    console.log(JSON.stringify({ outputDir, reportPath, status: summary.status }, null, 2));
  }

  if (summary.status !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
