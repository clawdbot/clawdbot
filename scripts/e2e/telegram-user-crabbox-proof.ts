#!/usr/bin/env -S node --import tsx
// Telegram User Crabbox Proof script supports OpenClaw repository automation.

import { type ChildProcess, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseStrictBooleanArg } from "../lib/arg-utils.mts";
import { coerceErrorMessage } from "../lib/error-format.mts";
import { terminateManagedChild } from "../lib/managed-child-process.mts";
import { sleep } from "../lib/sleep.mjs";
import { createPnpmRunnerSpawnSpec } from "../pnpm-runner.mts";
import { readPositiveIntEnv } from "./lib/env-limits.mjs";
import { readTextFileTail } from "./lib/text-file-utils.mjs";
import { telegramBotApi } from "./telegram-bot-api.ts";
import {
  COMMAND_TIMEOUT_MS,
  crabboxSshArgs,
  createCroppedMotionPreview as createSharedCroppedMotionPreview,
  createDesktopCrabboxWarmupArgs,
  createMotionPreview as createSharedMotionPreview,
  extractCrabboxLeaseId,
  inspectCrabbox as inspectSharedCrabbox,
  type CrabboxInspect,
  type CommandResult,
  type TelegramCrop,
  renderTelegramViewCommand,
  runCommand,
  scpFromRemote as sharedScpFromRemote,
  scpToRemote as sharedScpToRemote,
  selectedCrabboxSshArgs,
  selectCrabboxSshPort,
  shellQuote,
  sshRun as sharedSshRun,
  startRemoteRecording as startSharedRemoteRecording,
  stopRemoteRecording as stopSharedRemoteRecording,
  TELEGRAM_DESKTOP_CROP,
  TELEGRAM_DESKTOP_WINDOW,
  telegramPrivatePostLink,
} from "./telegram-desktop-crabbox.ts";
import {
  createMantisGatewayEnv as gatewayEnv,
  createMantisMockServerEnv as mockServerEnv,
  createOpenClawGatewaySpawnSpec,
  drainSutUpdates,
  preserveMantisSutRuntimeArtifacts,
  runSutContainerAction,
  startMantisSut,
  waitForLog,
  writeSutConfig,
} from "./telegram-mantis-sut.ts";

export { COMMAND_TIMEOUT_MS, runCommand, selectCrabboxSshPort };

type GatewaySpawnSpec = {
  args: string[];
  command: string;
  options: SpawnOptionsWithoutStdio;
};

type JsonObject = Record<string, unknown>;

type PreviewCrop = "telegram-window";

type Options = {
  crabboxClass: string;
  command:
    | "finish"
    | "inspect"
    | "probe"
    | "publish"
    | "restart"
    | "run"
    | "screenshot"
    | "send"
    | "start"
    | "status"
    | "view";
  crabboxBin: string;
  credentialRole: "ci" | "maintainer";
  chat?: string;
  desktopChatTitle: string;
  dryRun: boolean;
  envFile?: string;
  expect: string[];
  gatewayPort: number;
  humanDelayFixedMs?: number;
  idleTimeout: string;
  keepBox: boolean;
  leaseId?: string;
  linkPreview?: boolean;
  mcpAppFixture: boolean;
  mockResponseChunkDelayMs?: number;
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
  sutContainer: boolean;
  sutLane?: "baseline" | "candidate";
  sutRepoRoot?: string;
  sutUsername?: string;
  target: string;
  tdlibSha256?: string;
  tdlibUrl?: string;
  text: string;
  timeoutMs: number;
  ttl: string;
  userDriverScript: string;
  nodeBin: string;
  pnpmBin?: string;
};

type FunnelBridge = {
  proxyPath: string;
  tunnelLog: string;
  tunnelPid: number;
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
  funnelBridge?: FunnelBridge;
  containerName?: string;
  sutAttestation?: { lane: "baseline" | "candidate"; sha: string };
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
    configPath?: string;
    containerName?: string;
    sutAttestation?: { lane: "baseline" | "candidate"; sha: string };
    gatewayPort?: number;
    gatewayLog: string;
    gatewayPid: number;
    mockLog: string;
    mockPid: number;
    requestLog: string;
    stateDir: string;
    tempRoot: string;
    workspace: string;
    funnelBridge?: FunnelBridge;
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
export const REMOTE_SETUP_COMMAND_TIMEOUT_MS = 90 * 60 * 1000;
const REMOTE_ROOT = "/tmp/openclaw-telegram-user-crabbox";
const CREDENTIAL_SCRIPT = fileURLToPath(new URL("./telegram-user-credential.ts", import.meta.url));
export function readTelegramUserProofLogTailBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv("OPENCLAW_TELEGRAM_USER_PROOF_LOG_TAIL_BYTES", 256 * 1024, env);
}

const LOG_READY_TAIL_BYTES = readTelegramUserProofLogTailBytes();

function usageText() {
  return [
    "Usage:",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts [probe] [--text /status] [--expect OpenClaw]",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts start [--tdlib-url <url>]",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts send --session <session.json> --text <text>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts inspect --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts restart --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts run --session <session.json> -- <remote command>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts view --session <session.json> --message-id <id>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts screenshot --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts status --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts finish --session <session.json>",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts publish --session <session.json> --pr <number>",
    "",
    "Useful options:",
    "  --class <name>                Crabbox machine class. Default: standard.",
    "  --credential-role <role>      Convex role: maintainer or ci. Defaults by CI state.",
    "  --chat <id|username>          Telegram chat override for send (for example @bot for DM).",
    "  --desktop-chat-title <name>   Telegram Desktop chat to select before recording.",
    "  --human-delay-fixed-ms <ms>   Set a fixed custom human delay before Gateway startup.",
    "  --id <cbx_id>                 Reuse an existing Crabbox desktop lease.",
    "  --keep-box                    Leave the Crabbox lease running for VNC debugging.",
    "  --link-preview <true|false>   Set channels.telegram.linkPreview before Gateway startup.",
    "  --mock-response-file <path>    Text returned by the mock model.",
    "  --mock-response-chunk-delay-ms <ms> Split the mock reply across two delayed deltas.",
    "  --mcp-app-fixture              Configure the pinned MCP App fixture through a Crabbox Funnel.",
    "  --output-dir <path>           Artifact directory under the repo.",
    "  --message-id <id>             Telegram message id for proof-view deep link.",
    "  --preview-crop telegram-window Create a side-by-side friendly Telegram-window GIF.",
    "  --preview-crop-width <pixels>  Cropped preview GIF width. Default: 430.",
    "  --preview-fps <fps>            Motion GIF frames per second. Default: 24.",
    "  --preview-width <pixels>       Motion GIF width. Default: 1920.",
    "  --pr <number>                 Pull request number for publish.",
    "  --record-fps <fps>             Desktop recording frames per second. Default: 24.",
    "  --record-seconds <seconds>    Desktop video duration. Default: 35.",
    "  --repo <owner/name>           GitHub repo for publish. Default: openclaw/openclaw.",
    "  --session <path>              Session file from start. Default: <output-dir>/session.json.",
    "  --summary <text>              Artifact publish summary.",
    "  --sut-container               Isolate the local OpenClaw SUT in Docker.",
    "  --sut-lane <lane>             Attested prepared lane: baseline or candidate.",
    "  --sut-repo-root <path>        Prepared SUT checkout mounted by the isolation wrapper.",
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

const positiveIntegerPattern = /^[1-9]\d*$/u;
const SHORT_OPTION_TOKENS = new Set(["-h"]);

function isMissingOptionValue(value: string) {
  return !value || SHORT_OPTION_TOKENS.has(value) || value.startsWith("--");
}

function parsePositiveInteger(value: string, label: string) {
  const trimmed = value.trim();
  if (!positiveIntegerPattern.test(trimmed)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function resolveTelegramProofTimerTimeoutMs(value: number) {
  return clampTimerTimeoutMs(value) ?? 1;
}

function parsePositiveTimerMs(value: string, label: string) {
  return resolveTelegramProofTimerTimeoutMs(parsePositiveInteger(value, label));
}

function parseTcpPort(value: string, label: string) {
  const parsed = parsePositiveInteger(value, label);
  if (parsed > 65_535) {
    throw new Error(`${label} must be a TCP port from 1 to 65535.`);
  }
  return parsed;
}

function createTelegramProofRunId() {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
}

function isTruthyCi(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function resolveTelegramUserProofCredentialRole(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Options["credentialRole"] {
  const normalized = value?.trim().toLowerCase() || (isTruthyCi(env.CI) ? "ci" : "maintainer");
  if (normalized === "ci" || normalized === "maintainer") {
    return normalized;
  }
  throw new Error(`Credential role must be one of maintainer or ci, got "${value}".`);
}

export function parseArgs(argvInput: string[]): Options {
  let argv = argvInput;
  argv = argv[0] === "--" ? argv.slice(1) : argv;
  const commands = new Set([
    "finish",
    "inspect",
    "probe",
    "publish",
    "restart",
    "run",
    "screenshot",
    "send",
    "start",
    "status",
    "view",
  ]);
  const command = commands.has(argv[0] ?? "") ? (argv.shift() as Options["command"]) : "probe";
  const opts: Options = {
    crabboxClass: "standard",
    command,
    crabboxBin: trimToValue(process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN) ?? "crabbox",
    credentialRole: resolveTelegramUserProofCredentialRole(process.env.OPENCLAW_QA_CREDENTIAL_ROLE),
    desktopChatTitle:
      trimToValue(process.env.OPENCLAW_TELEGRAM_USER_DESKTOP_CHAT_TITLE) ?? "OpenClaw Testing",
    dryRun: false,
    expect: ["OpenClaw"],
    gatewayPort: 19_879,
    idleTimeout: "60m",
    keepBox: false,
    mcpAppFixture: false,
    mockResponseText: "OPENCLAW_E2E_OK",
    mockPort: 19_882,
    outputDir: path.join(DEFAULT_OUTPUT_ROOT, createTelegramProofRunId()),
    previewCropWidth: TELEGRAM_DESKTOP_CROP.cropWidth,
    previewFps: 24,
    previewWidth: 1920,
    provider: process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER?.trim() || "aws",
    publishFullArtifacts: false,
    publishRepo: "openclaw/openclaw",
    recordFps: 24,
    recordSeconds: 35,
    remoteCommand: [],
    sutContainer: process.env.MANTIS_CANDIDATE_TRUST === "fork-pr-head",
    target: "linux",
    text: "/status",
    timeoutMs: 90_000,
    ttl: "120m",
    userDriverScript:
      trimToValue(process.env.OPENCLAW_TELEGRAM_USER_DRIVER_SCRIPT) ?? DEFAULT_USER_DRIVER,
    nodeBin: trimToValue(process.env.MANTIS_NODE_BIN) ?? process.execPath,
    pnpmBin: trimToValue(process.env.MANTIS_PNPM_BIN),
  };
  const commandSeparator = argv.indexOf("--");
  if (command === "run" && commandSeparator >= 0) {
    opts.remoteCommand = argv.slice(commandSeparator + 1);
    argv = argv.slice(0, commandSeparator);
  }
  let expectWasPassed = false;
  const seenSingleValueOptions = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      usage();
    }
    const readValue = (options: { repeatable?: boolean } = {}) => {
      const value = argv[index + 1];
      if (value === undefined || isMissingOptionValue(value)) {
        usage();
      }
      if (!options.repeatable) {
        if (seenSingleValueOptions.has(arg)) {
          throw new Error(`${arg} was provided more than once`);
        }
        seenSingleValueOptions.add(arg);
      }
      index += 1;
      return value;
    };
    if (arg === "--class") {
      opts.crabboxClass = readValue();
    } else if (arg === "--chat") {
      opts.chat = readValue();
    } else if (arg === "--crabbox-bin") {
      opts.crabboxBin = readValue();
    } else if (arg === "--credential-role") {
      opts.credentialRole = resolveTelegramUserProofCredentialRole(readValue());
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
      opts.expect.push(readValue({ repeatable: true }));
    } else if (arg === "--gateway-port") {
      opts.gatewayPort = parseTcpPort(readValue(), "--gateway-port");
    } else if (arg === "--human-delay-fixed-ms") {
      opts.humanDelayFixedMs = parsePositiveTimerMs(readValue(), "--human-delay-fixed-ms");
    } else if (arg === "--id") {
      opts.leaseId = readValue();
    } else if (arg === "--idle-timeout") {
      opts.idleTimeout = readValue();
    } else if (arg === "--keep-box") {
      opts.keepBox = true;
    } else if (arg === "--link-preview") {
      opts.linkPreview = parseStrictBooleanArg(readValue(), "--link-preview");
    } else if (arg === "--mock-port") {
      opts.mockPort = parseTcpPort(readValue(), "--mock-port");
    } else if (arg === "--mock-response-file") {
      opts.mockResponseText = fs.readFileSync(resolveRepoPath(process.cwd(), readValue()), "utf8");
    } else if (arg === "--mock-response-chunk-delay-ms") {
      opts.mockResponseChunkDelayMs = parsePositiveTimerMs(
        readValue(),
        "--mock-response-chunk-delay-ms",
      );
    } else if (arg === "--mcp-app-fixture") {
      opts.mcpAppFixture = true;
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
    } else if (arg === "--sut-container") {
      opts.sutContainer = true;
    } else if (arg === "--sut-lane") {
      const lane = readValue();
      if (lane !== "baseline" && lane !== "candidate") {
        throw new Error("--sut-lane must be baseline or candidate.");
      }
      opts.sutLane = lane;
      opts.sutContainer = true;
    } else if (arg === "--sut-repo-root") {
      opts.sutRepoRoot = readValue();
      opts.sutContainer = true;
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
      opts.timeoutMs = parsePositiveTimerMs(readValue(), "--timeout-ms");
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
    [
      "finish",
      "inspect",
      "publish",
      "restart",
      "run",
      "screenshot",
      "send",
      "status",
      "view",
    ].includes(command) &&
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
  if (command !== "start" && opts.humanDelayFixedMs !== undefined) {
    throw new Error("--human-delay-fixed-ms is available only for start sessions.");
  }
  if (command !== "send" && opts.chat) {
    throw new Error("--chat is available only for held-session sends.");
  }
  if (opts.mcpAppFixture && command !== "start") {
    throw new Error("--mcp-app-fixture is available only for start sessions.");
  }
  if (opts.mcpAppFixture && opts.leaseId) {
    throw new Error("--mcp-app-fixture requires a fresh lifecycle-owned Crabbox lease.");
  }
  if (opts.mcpAppFixture && opts.sutContainer) {
    throw new Error("--mcp-app-fixture is unavailable for container-isolated SUT proof.");
  }
  if (command === "probe" && opts.sutContainer) {
    throw new Error("--sut-container requires the held-session start flow.");
  }
  if (command !== "start" && opts.sutRepoRoot) {
    throw new Error("--sut-repo-root is available only for start sessions.");
  }
  if (command !== "start" && opts.sutLane) {
    throw new Error("--sut-lane is available only for start sessions.");
  }
  if (Boolean(opts.sutRepoRoot) !== Boolean(opts.sutLane)) {
    throw new Error("--sut-repo-root and --sut-lane must be provided together.");
  }
  if (command === "start" && opts.sutContainer && (!opts.sutRepoRoot || !opts.sutLane)) {
    throw new Error("container proof requires --sut-repo-root and --sut-lane.");
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

export function createOpenClawCliSpawnSpec(params: {
  args: string[];
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  nodeExecPath?: string;
  npmExecPath?: string;
  pnpmExecPath?: string;
  platform?: NodeJS.Platform;
}): GatewaySpawnSpec {
  if (params.pnpmExecPath) {
    return {
      args: ["openclaw", ...params.args],
      command: params.pnpmExecPath,
      options: { cwd: params.repoRoot, env: params.env, shell: false },
    };
  }
  const spec = createPnpmRunnerSpawnSpec({
    cwd: params.repoRoot,
    env: params.env,
    nodeExecPath: params.nodeExecPath,
    npmExecPath: params.npmExecPath,
    platform: params.platform,
    pnpmArgs: ["openclaw", ...params.args],
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
    output = sliceUtf16Safe(`${output}${chunk}`, -12000);
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
    const resolvedTimeoutMs = resolveTelegramProofTimerTimeoutMs(timeoutMs);
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `${label} did not become ready within ${resolvedTimeoutMs}ms\n${sliceUtf16Safe(output(), -4000)}`,
        ),
      );
    }, resolvedTimeoutMs);
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
          `${label} exited before ready with code ${code ?? "unknown"}\n${sliceUtf16Safe(output(), -4000)}`,
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
  if (!child) {
    return;
  }
  terminateManagedChild(child, "SIGTERM");
}

export function signalPidTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

export function processTargetExists(target: number) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function isPidTreeAlive(pid: number) {
  for (const target of [-pid, pid]) {
    if (processTargetExists(target)) {
      return true;
    }
  }
  return false;
}

async function waitForPidTreeExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidTreeAlive(pid)) {
      return true;
    }
    await sleep(25);
  }
  return !isPidTreeAlive(pid);
}

async function stopPidTreeAndWait(pid: number) {
  signalPidTree(pid);
  if (await waitForPidTreeExit(pid, 5_000)) {
    return;
  }
  signalPidTree(pid, "SIGKILL");
  if (!(await waitForPidTreeExit(pid, 2_000))) {
    throw new Error(`Local SUT process group ${pid} did not exit.`);
  }
}

function spawnDaemon(params: {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
}) {
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

function waitForChildExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

export function readLogTail(logPath: string, maxBytes = LOG_READY_TAIL_BYTES): string {
  return readTextFileTail(logPath, Math.max(1, maxBytes));
}

export function readLogAfterOffset(
  logPath: string,
  offset: number,
  maxBytes = LOG_READY_TAIL_BYTES,
) {
  const size = fs.statSync(logPath).size;
  if (size <= offset) {
    return "";
  }
  const start = Math.max(offset, size - Math.max(1, maxBytes));
  const buffer = Buffer.alloc(size - start);
  const fd = fs.openSync(logPath, "r");
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

export async function waitForLogAfterOffset(params: {
  label: string;
  logPath: string;
  offset: number;
  pattern: RegExp;
  timeoutMs: number;
}) {
  const started = Date.now();
  while (Date.now() - started < params.timeoutMs) {
    const text = readLogAfterOffset(params.logPath, params.offset);
    if (params.pattern.test(text)) {
      return text;
    }
    await sleep(250);
  }
  const text = readLogAfterOffset(params.logPath, params.offset);
  throw new Error(
    `${params.label} was not observed within ${params.timeoutMs}ms\n${sliceUtf16Safe(text, -4000)}`,
  );
}

async function telegram(token: string, method: string, body: JsonObject = {}) {
  return await telegramBotApi(token, method, body);
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

type StartLocalSutDeps = {
  createGatewaySpawnSpec?: typeof createOpenClawGatewaySpawnSpec;
  drainUpdates?: typeof drainSutUpdates;
  spawnLoggedCommand?: typeof spawnLogged;
  waitForOutputReady?: typeof waitForOutput;
  writeConfig?: typeof writeSutConfig;
};

export async function startLocalSut(
  params: {
    gatewayPort: number;
    groupId: string;
    humanDelayFixedMs?: number;
    mockResponseText: string;
    mockPort: number;
    linkPreview?: boolean;
    mockResponseChunkDelayMs?: number;
    outputDir: string;
    sutToken: string;
    testerId: string;
    repoRoot: string;
    nodeBin?: string;
    pnpmBin?: string;
  },
  deps: StartLocalSutDeps = {},
) {
  const drainUpdates = deps.drainUpdates ?? drainSutUpdates;
  const writeConfig = deps.writeConfig ?? writeSutConfig;
  const spawnLoggedCommand = deps.spawnLoggedCommand ?? spawnLogged;
  const waitForOutputReady = deps.waitForOutputReady ?? waitForOutput;
  const createGatewaySpawnSpec = deps.createGatewaySpawnSpec ?? createOpenClawGatewaySpawnSpec;
  let gateway: ReturnType<typeof spawnLogged> | undefined;
  let mock: ReturnType<typeof spawnLogged> | undefined;
  try {
    const drained = await drainUpdates(params.sutToken);
    const config = writeConfig({ ...params, mockHost: "127.0.0.1" });
    const requestLog = path.join(params.outputDir, "mock-openai-requests.ndjson");
    mock = spawnLoggedCommand(
      params.nodeBin ?? process.execPath,
      ["scripts/e2e/mock-openai-server.mjs"],
      {
        cwd: params.repoRoot,
        env: mockServerEnv({ ...params, requestLog }),
      },
    );
    const runningMock = mock;
    await waitForOutputReady(
      runningMock.child,
      /mock-openai listening/u,
      () => runningMock.output,
      "mock-openai",
      10_000,
    );
    const gatewaySpec = createGatewaySpawnSpec({
      env: gatewayEnv({ ...config, sutToken: params.sutToken }),
      gatewayPort: params.gatewayPort,
      pnpmExecPath: params.pnpmBin,
      repoRoot: params.repoRoot,
    });
    gateway = spawnLoggedCommand(gatewaySpec.command, gatewaySpec.args, gatewaySpec.options);
    const runningGateway = gateway;
    await waitForOutputReady(
      runningGateway.child,
      /\[gateway\] ready/u,
      () => runningGateway.output,
      "gateway",
      60_000,
    );
    return {
      ...config,
      drained,
      gateway: runningGateway.child,
      get gatewayLog() {
        return runningGateway.output;
      },
      mock: runningMock.child,
      get mockLog() {
        return runningMock.output;
      },
      requestLog,
    };
  } catch (error) {
    killTree(gateway?.child);
    killTree(mock?.child);
    throw error;
  }
}

export async function recordProbeVideo(params: {
  crabboxBin: string;
  cwd: string;
  durationSeconds: number;
  leaseId: string;
  outputPath: string;
  provider: string;
  runProbe: () => Promise<void>;
  startDelayMs?: number;
  target: string;
}) {
  let recording: ChildProcess | undefined;
  try {
    recording = spawn(
      params.crabboxBin,
      [
        "artifacts",
        "video",
        "--provider",
        params.provider,
        "--target",
        params.target,
        "--id",
        params.leaseId,
        "--duration",
        `${params.durationSeconds}s`,
        "--output",
        params.outputPath,
      ],
      { cwd: params.cwd, stdio: "inherit" },
    );
    await sleep(params.startDelayMs ?? 3_000);
    await params.runProbe();
    const recordCode = await waitForChildExit(recording);
    if (recordCode !== 0) {
      throw new Error(`Crabbox recording failed with exit code ${recordCode ?? "unknown"}.`);
    }
  } finally {
    killTree(recording);
  }
}

async function stopLocalSutDaemon(
  sut:
    | {
        containerName?: string;
        gatewayPid?: number;
        mockPid?: number;
        tempRoot?: string;
      }
    | undefined,
) {
  let containerError: unknown;
  try {
    runSutContainerAction("stop", sut?.containerName, sut?.tempRoot);
  } catch (error) {
    containerError = error;
  }
  const pids = [...new Set([sut?.gatewayPid, sut?.mockPid].filter((pid) => pid !== undefined))];
  const processResults = await Promise.allSettled(pids.map((pid) => stopPidTreeAndWait(pid)));
  const processErrors = processResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (containerError || processErrors.length > 0) {
    throw new AggregateError(
      [...(containerError ? [containerError] : []), ...processErrors],
      "Local SUT did not quiesce cleanly.",
    );
  }
}

function destroyLocalSutRuntime(sut: { containerName?: string; tempRoot?: string } | undefined) {
  runSutContainerAction("destroy", sut?.containerName, sut?.tempRoot);
}

function cleanupFailureMessage(message: string, cleanupErrors: unknown[]) {
  const details = cleanupErrors.map(coerceErrorMessage);
  return [message, ...details.map((detail) => `Cleanup failure: ${detail}`)].join("\n");
}

function preserveLocalSutRuntimeArtifacts(
  sut: Pick<SessionFile["localSut"], "gatewayLog" | "mockLog" | "requestLog">,
  outputDir: string,
) {
  preserveMantisSutRuntimeArtifacts(sut, outputDir);
}

async function startLocalSutDaemon(params: {
  funnelBridge?: FunnelBridge;
  gatewayPort: number;
  groupId: string;
  humanDelayFixedMs?: number;
  mockResponseText: string;
  mockPort: number;
  linkPreview?: boolean;
  mcpAppFixture?: boolean;
  mockResponseChunkDelayMs?: number;
  outputDir: string;
  sutToken: string;
  testerId: string;
  repoRoot: string;
  nodeBin?: string;
  pnpmBin?: string;
  sutContainer?: boolean;
  sutLane?: "baseline" | "candidate";
}) {
  if (params.sutContainer) {
    if (!params.sutLane) {
      throw new Error("Container-isolated SUT requires an attested lane.");
    }
    if (params.funnelBridge) {
      throw new Error("Container-isolated fork SUT does not support the MCP App Funnel fixture.");
    }
    const sut = await startMantisSut({
      configPatch: {
        ...(params.humanDelayFixedMs === undefined
          ? {}
          : {
              agents: {
                defaults: {
                  humanDelay: {
                    maxMs: params.humanDelayFixedMs,
                    minMs: params.humanDelayFixedMs,
                    mode: "custom",
                  },
                },
              },
            }),
        ...(params.linkPreview === undefined
          ? {}
          : { channels: { telegram: { linkPreview: params.linkPreview } } }),
      },
      gatewayPort: params.gatewayPort,
      groupId: params.groupId,
      mockPort: params.mockPort,
      mockResponseChunkDelayMs: params.mockResponseChunkDelayMs,
      mockResponseText: params.mockResponseText,
      outputDir: params.outputDir,
      repoRoot: params.repoRoot,
      sutLane: params.sutLane,
      sutToken: params.sutToken,
      testerId: params.testerId,
    });
    return {
      ...sut,
      mockPid: sut.gatewayPid,
      funnelBridge: params.funnelBridge,
    };
  }
  const drained = await drainSutUpdates(params.sutToken);
  const config = writeSutConfig({ ...params, mockHost: "127.0.0.1" });
  const gatewayPassword = params.mcpAppFixture ? randomUUID() : undefined;
  const runtimeLogRoot = params.sutContainer ? config.tempRoot : params.outputDir;
  const requestLog = path.join(runtimeLogRoot, "mock-openai-requests.ndjson");
  const mockLog = path.join(runtimeLogRoot, "mock-openai.log");
  const gatewayLog = path.join(runtimeLogRoot, "gateway.log");
  let mockPid: number | undefined;
  let gatewayPid: number | undefined;
  try {
    mockPid = spawnDaemon({
      command: params.nodeBin ?? process.execPath,
      args: ["scripts/e2e/mock-openai-server.mjs"],
      cwd: params.repoRoot,
      env: mockServerEnv({ ...params, requestLog }),
      logPath: mockLog,
    });
    if (!mockPid) {
      throw new Error("mock-openai did not start.");
    }
    await waitForLog(mockLog, /mock-openai listening/u, "mock-openai", 10_000);

    const gatewayEnvVars = gatewayEnv({
      ...config,
      gatewayPassword,
      sutToken: params.sutToken,
      tailscaleProxyDir: params.funnelBridge
        ? path.dirname(params.funnelBridge.proxyPath)
        : undefined,
    });
    const gatewaySpec = createOpenClawGatewaySpawnSpec({
      env: gatewayEnvVars,
      gatewayPort: params.gatewayPort,
      pnpmExecPath: params.pnpmBin,
      repoRoot: params.repoRoot,
    });
    gatewayPid = spawnDaemon({
      args: gatewaySpec.args,
      command: gatewaySpec.command,
      cwd: (gatewaySpec.options.cwd ?? params.repoRoot) as string,
      env: gatewaySpec.options.env ?? gatewayEnvVars,
      logPath: gatewayLog,
      shell: gatewaySpec.options.shell as boolean | undefined,
      windowsVerbatimArguments: gatewaySpec.options.windowsVerbatimArguments,
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
      funnelBridge: params.funnelBridge,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await stopLocalSutDaemon({
        gatewayPid,
        mockPid,
        tempRoot: config.tempRoot,
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
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

export function createCrabboxWarmupArgs(
  opts: Pick<
    Options,
    "crabboxClass" | "idleTimeout" | "mcpAppFixture" | "provider" | "target" | "ttl"
  >,
) {
  return createDesktopCrabboxWarmupArgs({
    browser: true,
    crabboxClass: opts.crabboxClass,
    idleTimeout: opts.idleTimeout,
    provider: opts.provider,
    tailscale: opts.mcpAppFixture,
    target: opts.target,
    ttl: opts.ttl,
  });
}

async function warmupCrabbox(opts: Options, root: string) {
  const result = await runCommand({
    command: opts.crabboxBin,
    args: createCrabboxWarmupArgs(opts),
    cwd: root,
    stdio: "inherit",
  });
  const leaseId = extractCrabboxLeaseId(`${result.stdout}\n${result.stderr}`);
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
  return await createSharedMotionPreview({
    crabboxBin: params.opts.crabboxBin,
    cwd: params.root,
    fps: params.opts.previewFps,
    gifPath: params.motionGifPath,
    trimmedVideoPath: params.motionVideoPath,
    videoPath: params.videoPath,
    width: params.opts.previewWidth,
  });
}

function previewCrop(opts: Options) {
  return opts.previewCrop === "telegram-window"
    ? { ...TELEGRAM_DESKTOP_CROP, cropWidth: opts.previewCropWidth }
    : undefined;
}

async function createCroppedMotionPreview(params: {
  crop: TelegramCrop;
  croppedGifPath: string;
  croppedVideoPath: string;
  opts: Options;
  root: string;
  videoPath: string;
}) {
  return await createSharedCroppedMotionPreview({
    crabboxBin: params.opts.crabboxBin,
    crop: params.crop,
    croppedGifPath: params.croppedGifPath,
    croppedVideoPath: params.croppedVideoPath,
    cwd: params.root,
    fps: params.opts.previewFps,
    videoPath: params.videoPath,
  });
}

async function inspectCrabbox(opts: Options, root: string, leaseId: string) {
  return await inspectSharedCrabbox({
    crabboxBin: opts.crabboxBin,
    cwd: root,
    leaseId,
    provider: opts.provider,
    target: opts.target,
  });
}

async function scpToRemote(root: string, inspect: CrabboxInspect, local: string, remote: string) {
  await sharedScpToRemote({
    cwd: root,
    inspect,
    local,
    remote,
  });
}

async function scpFromRemote(root: string, inspect: CrabboxInspect, remote: string, local: string) {
  await sharedScpFromRemote({
    cwd: root,
    inspect,
    local,
    remote,
  });
}

async function sshRun(
  root: string,
  inspect: CrabboxInspect,
  remoteCommand: string,
  options: { outputFile?: string; timeoutMs?: number } = {},
) {
  return await sharedSshRun({
    command: remoteCommand,
    cwd: root,
    inspect,
    outputFile: options.outputFile,
    timeoutMs: options.timeoutMs,
  });
}

export function renderTailscaleSshProxy(params: { gatewayPort: number; inspect: CrabboxInspect }) {
  const ssh = crabboxSshArgs(params.inspect);
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const port = ${JSON.stringify(String(params.gatewayPort))};
const allowed =
  (args.length === 1 && args[0] === "--version") ||
  (args.length === 2 && args[0] === "status" && args[1] === "--json") ||
  (args.length === 4 && args[0] === "funnel" && args[1] === "--bg" && args[2] === "--yes" && args[3] === port) ||
  (args.length === 2 && args[0] === "funnel" && args[1] === "reset");
if (!allowed) {
  process.stderr.write("unsupported proof Tailscale command\\n");
  process.exit(64);
}
const quote = (value) => "'" + value.replaceAll("'", "'\\\\''") + "'";
const remoteCommand = ["tailscale", ...args].map(quote).join(" ");
const result = spawnSync("ssh", ${JSON.stringify([...ssh.base, ssh.target])}.concat(remoteCommand), {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`;
}

async function startTailscaleFunnelBridge(params: {
  gatewayPort: number;
  inspect: CrabboxInspect;
  localRoot: string;
}) {
  if (!params.inspect.tailscale) {
    throw new Error("MCP App fixture proof requires a Tailscale-enabled Crabbox lease.");
  }
  // Keep the SUT local while letting its real Gateway lifecycle own Funnel on
  // the Tailscale-enabled desktop lease; no Tailscale credential leaves Crabbox.
  const proxyPath = path.join(params.localRoot, "tailscale");
  const ssh = await selectedCrabboxSshArgs(params.localRoot, params.inspect, runCommand);
  await writeExecutable(
    proxyPath,
    renderTailscaleSshProxy({
      gatewayPort: params.gatewayPort,
      inspect: { ...params.inspect, sshPort: ssh.sshPort },
    }),
  );
  const tunnelLog = path.join(params.localRoot, "gateway-funnel-tunnel.log");
  const tunnelPid = spawnDaemon({
    args: [
      ...ssh.base,
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-R",
      `127.0.0.1:${params.gatewayPort}:127.0.0.1:${params.gatewayPort}`,
      ssh.target,
    ],
    command: "ssh",
    cwd: params.localRoot,
    env: childProcessBaseEnv(),
    logPath: tunnelLog,
  });
  if (!tunnelPid) {
    throw new Error("Gateway Funnel reverse tunnel did not start.");
  }
  await sleep(500);
  try {
    process.kill(tunnelPid, 0);
  } catch {
    throw new Error(`Gateway Funnel reverse tunnel exited early.\n${readLogTail(tunnelLog)}`);
  }
  return { proxyPath, tunnelLog, tunnelPid };
}

async function stopTailscaleFunnelBridge(
  root: string,
  bridge: Pick<FunnelBridge, "proxyPath" | "tunnelPid">,
) {
  try {
    // The proof owns this fresh Funnel lease, so it explicitly removes the route.
    await runCommand({
      args: ["funnel", "reset"],
      command: bridge.proxyPath,
      cwd: root,
      timeoutMs: 30_000,
    });
  } finally {
    signalPidTree(bridge.tunnelPid);
  }
}

export function renderRemoteSetup(params: { tdlibSha256?: string; tdlibUrl?: string }) {
  const tdlibSha256 = shellQuote(params.tdlibSha256 ?? "");
  const tdlibUrl = shellQuote(params.tdlibUrl ?? "");
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
tdlib_sha256=${tdlibSha256}
tdlib_url=${tdlibUrl}
setup_step_timeout_kill_after="\${OPENCLAW_TELEGRAM_USER_SETUP_KILL_AFTER_SECONDS:-30}s"
apt_timeout="\${OPENCLAW_TELEGRAM_USER_APT_TIMEOUT_SECONDS:-900}s"
download_timeout="\${OPENCLAW_TELEGRAM_USER_DOWNLOAD_TIMEOUT_SECONDS:-600}"
download_connect_timeout="\${OPENCLAW_TELEGRAM_USER_DOWNLOAD_CONNECT_TIMEOUT_SECONDS:-15}"
download_retries="\${OPENCLAW_TELEGRAM_USER_DOWNLOAD_RETRIES:-3}"
download_retry_delay="\${OPENCLAW_TELEGRAM_USER_DOWNLOAD_RETRY_DELAY_SECONDS:-5}"
tdlib_clone_timeout="\${OPENCLAW_TELEGRAM_USER_TDLIB_CLONE_TIMEOUT_SECONDS:-600}s"
tdlib_build_timeout="\${OPENCLAW_TELEGRAM_USER_TDLIB_BUILD_TIMEOUT_SECONDS:-1800}s"
run_setup_step() {
  local label="$1"
  local timeout_value="$2"
  shift 2
  echo "==> $label" >&2
  timeout --kill-after="$setup_step_timeout_kill_after" "$timeout_value" "$@"
}
download_file() {
  local url="$1"
  local output="$2"
  curl -fL \
    --connect-timeout "$download_connect_timeout" \
    --max-time "$download_timeout" \
    --retry "$download_retries" \
    --retry-delay "$download_retry_delay" \
    --retry-all-errors \
    -o "$output" \
    "$url"
}
mkdir -p "$root"
tar -xzf "$root/state.tgz" -C "$root"
run_setup_step "apt-get update" "$apt_timeout" sudo apt-get -o DPkg::Lock::Timeout=900 update -y
run_setup_step "apt-get install" "$apt_timeout" sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=900 install -y curl git cmake g++ make zlib1g-dev libssl-dev python3 ffmpeg scrot xz-utils tar wmctrl xdotool x11-utils zbar-tools libopengl0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xinerama0 libxkbcommon-x11-0 >/tmp/openclaw-telegram-apt.log
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 127
fi
if [ ! -x "$root/Telegram/Telegram" ]; then
  download_file https://telegram.org/dl/desktop/linux "$root/telegram.tar.xz"
  tar -xJf "$root/telegram.tar.xz" -C "$root"
fi
if ! ldconfig -p | grep -q libtdjson.so; then
  if [ -n "$tdlib_url" ]; then
    download_file "$tdlib_url" "$root/tdlib-linux.tgz"
    if [ -z "$tdlib_sha256" ]; then
      download_file "$tdlib_url.sha256" "$root/tdlib-linux.tgz.sha256"
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
    run_setup_step "tdlib clone" "$tdlib_clone_timeout" git clone --depth 1 --branch v1.8.0 https://github.com/tdlib/td.git "$root/td"
    run_setup_step "tdlib configure" "$tdlib_build_timeout" cmake -S "$root/td" -B "$root/td-build" -DCMAKE_BUILD_TYPE=Release -DTD_ENABLE_JNI=OFF
    run_setup_step "tdlib build" "$tdlib_build_timeout" cmake --build "$root/td-build" --target tdjson -j "$(nproc)"
    run_setup_step "tdlib install" "$apt_timeout" sudo cmake --install "$root/td-build"
  fi
  sudo ldconfig
fi
TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" status --json --timeout-ms 60000 >"$root/status.json"
TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" terminate-desktop-sessions --json --timeout-ms 60000 --output "$root/desktop-sessions-cleanup.json"
`;
}

export function renderLaunchDesktop() {
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export DISPLAY="\${DISPLAY:-:99}"
print_desktop_log_tail() {
  local log_file="$root/telegram-desktop.log"
  [ -f "$log_file" ] || return 0
  tail -c 262144 "$log_file" >&2 || true
}
pkill -f "$root/Telegram/Telegram" >/dev/null 2>&1 || true
rm -rf "$root/desktop/tdata"
nohup "$root/Telegram/Telegram" -workdir "$root/desktop" >"$root/telegram-desktop.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" >/dev/null 2>&1; then
  print_desktop_log_tail
  exit 1
fi
if ! wmctrl -l | grep -i telegram >/dev/null 2>&1; then
  print_desktop_log_tail
  exit 1
fi
`;
}

function renderAuthorizeDesktop() {
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export DISPLAY="\${DISPLAY:-:99}"
win="$(wmctrl -l | awk 'tolower($0) ~ /telegram/ {print $1; exit}')"
test -n "$win"
xdotool windowactivate "$win"
sleep 5
click_window_ratio() {
  eval "$(xdotool getwindowgeometry --shell "$win")"
  xdotool windowactivate "$win"
  sleep 0.2
  xdotool mousemove "$((X + WIDTH / 2))" "$((Y + HEIGHT * $1 / 100))"
  sleep 0.2
  xdotool click 1
  sleep 1
}
read_qr_link() {
  scrot -o "$root/telegram-login-qr.png"
  { zbarimg --raw "$root/telegram-login-qr.png" 2>/dev/null || true; } | awk 'index($0, "tg://login?token=") == 1 {print; exit}'
}
wait_for_qr_link() {
  for _ in $(seq 1 25); do
    link="$(read_qr_link)"
    if [ -n "$link" ]; then
      printf '%s\\n' "$link"
      return 0
    fi
    sleep 1
  done
  return 1
}
click_window_ratio 69
sleep 3
click_window_ratio 80
link="$(wait_for_qr_link)" || {
  echo "Telegram Desktop QR login code was not found." >&2
  exit 1
}
export TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver"
python3 "$root/user-driver.py" confirm-qr --link "$link" --json --output "$root/desktop-session.json"
python3 - "$root/desktop-session.json" <<'PY'
import json
import sys
payload = json.loads(open(sys.argv[1]).read())
session = payload.get("session") or {}
if session.get("isPasswordPending"):
    raise SystemExit("Telegram Desktop QR login requires a 2FA password.")
PY
sleep 6
`;
}

export function renderSelectDesktopChat(params: { chatTitle: string }) {
  return `#!/usr/bin/env bash
set -euo pipefail
chat_title=${shellQuote(params.chatTitle)}
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

export function renderRemoteProbe(params: {
  chat?: string;
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
  if (params.chat) {
    args.push("--chat", params.chat);
  }
  for (const expected of params.expect) {
    args.push("--expect", expected);
  }
  const escapedArgs = args.map(shellQuote).join(" ");
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver"
export TELEGRAM_USER_DRIVER_SUT_USERNAME=${shellQuote(params.sutUsername)}
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
    "--credential-role",
    params.opts.credentialRole,
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

const FULL_ARTIFACT_JSON_NAMES = new Set([
  "probe.json",
  "status.json",
  "telegram-user-crabbox-proof-summary.json",
  "telegram-user-crabbox-session-summary.json",
]);
const FULL_ARTIFACT_FILE_EXTENSIONS = new Set([".gif", ".log", ".md", ".mp4", ".png"]);
const FULL_ARTIFACT_PROOF_REPORT = "telegram-user-crabbox-proof.md";
const TIMESTAMPED_PROBE_ARTIFACT_JSON = /^probe-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/u;

function isFullArtifactJsonName(name: string) {
  return FULL_ARTIFACT_JSON_NAMES.has(name) || TIMESTAMPED_PROBE_ARTIFACT_JSON.test(name);
}

export function stageFullSessionArtifacts(outputDir: string) {
  if (!fs.existsSync(path.join(outputDir, FULL_ARTIFACT_PROOF_REPORT))) {
    throw new Error(`Missing proof report. Run finish first: ${FULL_ARTIFACT_PROOF_REPORT}`);
  }

  const publishDir = path.join(outputDir, "publish-full-artifacts");
  fs.rmSync(publishDir, { force: true, recursive: true });
  fs.mkdirSync(publishDir, { recursive: true });

  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name);
    const isPublishableArtifact =
      FULL_ARTIFACT_FILE_EXTENSIONS.has(extension) || isFullArtifactJsonName(entry.name);
    if (!isPublishableArtifact) {
      continue;
    }
    fs.copyFileSync(path.join(outputDir, entry.name), path.join(publishDir, entry.name));
  }

  return publishDir;
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
  const authorizeScript = path.join(params.localRoot, "authorize-desktop.sh");
  const selectChatScript = path.join(params.localRoot, "select-desktop-chat.sh");
  await writeExecutable(
    setupScript,
    renderRemoteSetup({ tdlibSha256: params.opts.tdlibSha256, tdlibUrl: params.opts.tdlibUrl }),
  );
  await writeExecutable(launchScript, renderLaunchDesktop());
  await writeExecutable(authorizeScript, renderAuthorizeDesktop());
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
    authorizeScript,
    `${REMOTE_ROOT}/authorize-desktop.sh`,
  );
  await scpToRemote(
    params.root,
    params.inspect,
    selectChatScript,
    `${REMOTE_ROOT}/select-desktop-chat.sh`,
  );
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/remote-setup.sh`, {
    timeoutMs: REMOTE_SETUP_COMMAND_TIMEOUT_MS,
  });
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/launch-desktop.sh`);
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/authorize-desktop.sh`);
  await sshRun(params.root, params.inspect, `bash ${REMOTE_ROOT}/select-desktop-chat.sh`);
  await sshRun(
    params.root,
    params.inspect,
    `cat >${REMOTE_ROOT}/env.sh <<'EOF'
export TELEGRAM_USER_DRIVER_STATE_DIR=${REMOTE_ROOT}/user-driver
export TELEGRAM_USER_DRIVER_SUT_USERNAME=${shellQuote(params.sutUsername)}
EOF
`,
  );
}

async function startRemoteRecording(root: string, inspect: CrabboxInspect, opts: Options) {
  const paths = await startSharedRemoteRecording({
    cwd: root,
    inspect,
    paths: {
      ffmpegLog: `${REMOTE_ROOT}/ffmpeg.log`,
      ffmpegPid: `${REMOTE_ROOT}/ffmpeg.pid`,
      video: `${REMOTE_ROOT}/session.mp4`,
    },
    recordFps: opts.recordFps,
  });
  return { log: paths.ffmpegLog, pidFile: paths.ffmpegPid, remoteVideo: paths.video };
}

async function stopRemoteRecording(root: string, inspect: CrabboxInspect, session: SessionFile) {
  await stopSharedRemoteRecording({
    cwd: root,
    inspect,
    pidFile: session.recorder.pidFile,
  });
}

async function terminateRemoteDesktopSession(root: string, inspect: CrabboxInspect) {
  await sshRun(
    root,
    inspect,
    `set -euo pipefail
root=${REMOTE_ROOT}
if [ ! -s "$root/desktop-session.json" ]; then
  exit 0
fi
session_id="$(python3 - "$root/desktop-session.json" <<'PY'
import json
import sys
payload = json.loads(open(sys.argv[1]).read())
print((payload.get("session") or {}).get("id") or "")
PY
)"
if [ -z "$session_id" ]; then
  exit 0
fi
export TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver"
python3 "$root/user-driver.py" terminate-session --session-id "$session_id" --json --output "$root/desktop-session-terminated.json"`,
  );
}

async function startSession(root: string, opts: Options, outputDir: string) {
  const localRoot = path.join(outputDir, ".session");
  fs.rmSync(localRoot, { force: true, recursive: true });
  fs.mkdirSync(localRoot, { mode: 0o700, recursive: true });

  const convexEnvFile = expandHome(opts.envFile ?? DEFAULT_CONVEX_ENV_FILE);
  const roleSecret =
    opts.credentialRole === "ci"
      ? process.env.OPENCLAW_QA_CONVEX_SECRET_CI
      : process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER;
  const hasConvexEnv =
    trimToValue(process.env.OPENCLAW_QA_CONVEX_SITE_URL) && trimToValue(roleSecret);
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
  let credential: Awaited<ReturnType<typeof leaseCredential>> | undefined;
  let leaseId = opts.leaseId;
  let createdLease = false;
  let localSut: Awaited<ReturnType<typeof startLocalSutDaemon>> | undefined;
  let funnelBridge: Awaited<ReturnType<typeof startTailscaleFunnelBridge>> | undefined;
  try {
    credential = await leaseCredential({ localRoot, opts, root });
    const sut = opts.sutUsername
      ? { id: "", username: opts.sutUsername }
      : await sutIdentity(credential.sutToken);
    const stateArchive = await prepareRemoteState({ localRoot, opts, root });
    if (!leaseId) {
      leaseId = await warmupCrabbox(opts, root);
      createdLease = true;
    }
    const inspect = await inspectCrabbox(opts, root, leaseId);
    if (opts.mcpAppFixture) {
      funnelBridge = await startTailscaleFunnelBridge({
        gatewayPort: opts.gatewayPort,
        inspect,
        localRoot,
      });
    }
    await writeRemoteSessionScripts({
      inspect,
      localRoot,
      opts,
      root,
      stateArchive,
      sutUsername: sut.username,
    });
    localSut = await startLocalSutDaemon({
      funnelBridge,
      gatewayPort: opts.gatewayPort,
      groupId: credential.groupId,
      humanDelayFixedMs: opts.humanDelayFixedMs,
      linkPreview: opts.linkPreview,
      mockResponseText: opts.mockResponseText,
      mockResponseChunkDelayMs: opts.mockResponseChunkDelayMs,
      mockPort: opts.mockPort,
      mcpAppFixture: opts.mcpAppFixture,
      outputDir,
      nodeBin: opts.nodeBin,
      pnpmBin: opts.pnpmBin,
      repoRoot: opts.sutRepoRoot ? path.resolve(root, opts.sutRepoRoot) : root,
      sutToken: credential.sutToken,
      sutContainer: opts.sutContainer,
      sutLane: opts.sutLane,
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
      localSut: { ...localSut, gatewayPort: opts.gatewayPort },
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
        send: `openclaw-telegram-user-crabbox-proof send --session ${path.relative(root, pathname)} --text '/status'`,
        inspect: `openclaw-telegram-user-crabbox-proof inspect --session ${path.relative(root, pathname)}`,
        restart: `openclaw-telegram-user-crabbox-proof restart --session ${path.relative(root, pathname)}`,
        view: `openclaw-telegram-user-crabbox-proof view --session ${path.relative(root, pathname)} --message-id <message-id>`,
        run: `openclaw-telegram-user-crabbox-proof run --session ${path.relative(root, pathname)} -- bash -lc 'source ${REMOTE_ROOT}/env.sh && python3 ${REMOTE_ROOT}/user-driver.py transcript --limit 20 --json'`,
        finish: `openclaw-telegram-user-crabbox-proof finish --session ${path.relative(root, pathname)} --preview-crop telegram-window`,
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let sutQuiesced = false;
    if (localSut) {
      try {
        await stopLocalSutDaemon(localSut);
        sutQuiesced = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (sutQuiesced) {
        try {
          preserveLocalSutRuntimeArtifacts(localSut, outputDir);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        destroyLocalSutRuntime(localSut);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (funnelBridge) {
      await stopTailscaleFunnelBridge(root, funnelBridge).catch(() => {});
    }
    if (credential) {
      await releaseCredential(root, opts, credential.leaseFile).catch(() => {});
    }
    if (leaseId && createdLease) {
      await stopCrabbox(root, opts, leaseId).catch(() => {});
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        cleanupFailureMessage(
          "Telegram proof startup failed and local SUT cleanup was incomplete.",
          cleanupErrors,
        ),
        { cause: error },
      );
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
      chat: opts.chat?.replaceAll("{sut}", session.credential.sutUsername),
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
  const logPath = path.join(
    session.outputDir,
    `remote-command-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`,
  );
  await sshRun(root, session.crabbox.inspect, command, { outputFile: logPath });
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

function sessionSutConfigPath(session: SessionFile) {
  return session.localSut.configPath ?? path.join(session.localSut.tempRoot, "openclaw.json");
}

async function runSessionAuditCli(
  root: string,
  opts: Options,
  session: SessionFile,
  args: string[],
) {
  const spec = createOpenClawCliSpawnSpec({
    args,
    env: {
      ...childProcessBaseEnv(),
      OPENCLAW_CONFIG_PATH: sessionSutConfigPath(session),
      OPENCLAW_STATE_DIR: session.localSut.stateDir,
    },
    repoRoot: root,
    nodeExecPath: opts.nodeBin,
    pnpmExecPath: opts.pnpmBin,
  });
  const cwd = spec.options.cwd;
  return await runCommand({
    command: spec.command,
    args: spec.args,
    cwd: typeof cwd === "string" ? cwd : cwd ? fileURLToPath(cwd) : root,
    env: spec.options.env,
    shell: spec.options.shell,
    timeoutMs: opts.timeoutMs,
    windowsVerbatimArguments: spec.options.windowsVerbatimArguments,
  });
}

function parseCommandJson(result: CommandResult, label: string): JsonObject {
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${coerceErrorMessage(error)}`, {
      cause: error,
    });
  }
}

function inspectIdentityContext(result: JsonObject): JsonObject | undefined {
  const identity = result.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    return undefined;
  }
  const record = identity as JsonObject;
  return record.state === "present" && record.context && typeof record.context === "object"
    ? (record.context as JsonObject)
    : undefined;
}

export function hasBoundaryVerifiedChannelAdmissionAssurance(context: unknown): boolean {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return false;
  }
  const ingress = (context as JsonObject).ingress;
  const assurance = (context as JsonObject).assurance;
  return (
    ingress !== null &&
    typeof ingress === "object" &&
    !Array.isArray(ingress) &&
    (ingress as JsonObject).kind === "channel" &&
    Array.isArray(assurance) &&
    assurance.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }
      return (
        (item as JsonObject).kind === "channel-admission" &&
        (item as JsonObject).strength === "boundary-verified" &&
        typeof (item as JsonObject).evidenceRef === "string"
      );
    })
  );
}

async function inspectSessionIdentity(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const listed = parseCommandJson(
    await runSessionAuditCli(root, opts, session, [
      "audit",
      "--kind",
      "agent_run",
      "--limit",
      "500",
      "--json",
    ]),
    "audit activity list",
  );
  const events = Array.isArray(listed.events) ? listed.events : [];
  const runIds = [
    ...new Set(
      events.flatMap((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          return [];
        }
        const runId = (event as JsonObject).runId;
        return typeof runId === "string" && runId.trim() ? [runId] : [];
      }),
    ),
  ];
  const inspections: Array<{ human: string; json: JsonObject; runId: string }> = [];
  for (const runId of runIds) {
    const json = parseCommandJson(
      await runSessionAuditCli(root, opts, session, [
        "audit",
        "--run",
        runId,
        "--explain",
        "--json",
      ]),
      `audit inspection ${runId}`,
    );
    const context = inspectIdentityContext(json);
    if (!context) {
      continue;
    }
    const ingress = context.ingress;
    if (
      !ingress ||
      typeof ingress !== "object" ||
      Array.isArray(ingress) ||
      (ingress as JsonObject).kind !== "channel"
    ) {
      continue;
    }
    const human = (
      await runSessionAuditCli(root, opts, session, ["audit", "--run", runId, "--explain"])
    ).stdout;
    inspections.push({ human, json, runId });
  }
  if (inspections.length < 2) {
    throw new Error(
      `Telegram DM/group proof requires at least two admitted channel runs; found ${inspections.length}.`,
    );
  }
  const contextsByRun = Object.fromEntries(
    inspections.map(({ json, runId }) => [runId, inspectIdentityContext(json)]),
  );
  const serialized = JSON.stringify({ contextsByRun, inspections });
  for (const raw of [
    session.credential.groupId,
    session.credential.testerUserId,
    session.credential.testerUsername,
  ]) {
    if (raw && serialized.includes(raw)) {
      throw new Error("Telegram audit inspection retained a raw participant or room identifier.");
    }
  }
  const principalRefs = new Set<string>();
  for (const inspection of inspections) {
    const context = inspectIdentityContext(inspection.json);
    const invoker = context?.invoker;
    const principal =
      invoker && typeof invoker === "object" && !Array.isArray(invoker)
        ? (invoker as JsonObject).principal
        : undefined;
    const principalRef =
      principal && typeof principal === "object" && !Array.isArray(principal)
        ? (principal as JsonObject).principalRef
        : undefined;
    const hasChannelAdmission = hasBoundaryVerifiedChannelAdmissionAssurance(context);
    if (
      !invoker ||
      typeof invoker !== "object" ||
      Array.isArray(invoker) ||
      (invoker as JsonObject).state !== "present" ||
      !principal ||
      typeof principal !== "object" ||
      Array.isArray(principal) ||
      (principal as JsonObject).kind !== "person" ||
      typeof principalRef !== "string" ||
      !hasChannelAdmission ||
      !inspection.human.includes("Invoker [present]") ||
      !inspection.human.includes("channel-admission") ||
      !inspection.human.includes("Decisions")
    ) {
      throw new Error(`Telegram run ${inspection.runId} omitted participant CLI evidence.`);
    }
    principalRefs.add(principalRef);
  }
  if (principalRefs.size !== 1) {
    throw new Error("Telegram DM and group runs did not retain the same participant principal.");
  }

  const jsonPath = path.join(session.outputDir, "telegram-execution-identity.private.json");
  const textPath = path.join(session.outputDir, "telegram-execution-identity.private.txt");
  const previous = readJsonFile(jsonPath);
  const previousContexts =
    previous.contextsByRun &&
    typeof previous.contextsByRun === "object" &&
    !Array.isArray(previous.contextsByRun)
      ? (previous.contextsByRun as JsonObject)
      : undefined;
  const stableAcrossRestart = previousContexts
    ? Object.entries(previousContexts).every(
        ([runId, context]) => JSON.stringify(contextsByRun[runId]) === JSON.stringify(context),
      )
    : undefined;
  if (stableAcrossRestart === false) {
    throw new Error("Telegram execution identity context changed across Gateway restart.");
  }
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify({ contextsByRun, runIds: inspections.map((item) => item.runId) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(jsonPath, 0o600);
  fs.writeFileSync(
    textPath,
    inspections.map((item) => `# ${item.runId}\n${item.human.trim()}\n`).join("\n"),
    { mode: 0o600 },
  );
  fs.chmodSync(textPath, 0o600);
  return {
    inspectionCount: inspections.length,
    json: path.relative(root, jsonPath),
    runIds: inspections.map((item) => item.runId),
    stableAcrossRestart: stableAcrossRestart ?? null,
    status: "pass",
    text: path.relative(root, textPath),
  };
}

export async function restartSessionGateway(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  if (session.localSut.containerName) {
    throw new Error(
      "Held-session restart requires the lifecycle-owned host Gateway; container sessions are unsupported.",
    );
  }
  const gatewayPort = session.localSut.gatewayPort ?? opts.gatewayPort;
  const offset = fs.statSync(session.localSut.gatewayLog).size;
  const restart = parseCommandJson(
    await runSessionAuditCli(root, opts, session, [
      "gateway",
      "call",
      "gateway.restart.request",
      "--port",
      String(gatewayPort),
      "--params",
      JSON.stringify({ reason: "telegram-user-crabbox-proof" }),
      "--json",
    ]),
    "Gateway restart request",
  );
  if (restart.ok !== true || restart.status !== "scheduled") {
    throw new Error(`Gateway restart request was not scheduled: ${JSON.stringify(restart)}`);
  }
  await waitForLogAfterOffset({
    label: "Gateway restart boundary",
    logPath: session.localSut.gatewayLog,
    offset,
    pattern: /received SIGUSR1; restarting/u,
    timeoutMs: opts.timeoutMs,
  });
  await waitForLogAfterOffset({
    label: "Gateway restart readiness",
    logPath: session.localSut.gatewayLog,
    offset,
    pattern: /gateway ready|restart trace: restart\.ready/u,
    timeoutMs: opts.timeoutMs,
  });
  return { gatewayPort, logOffset: offset, status: "pass" };
}

function renderProofViewCommand(link: string) {
  return renderTelegramViewCommand({
    binary: `${REMOTE_ROOT}/Telegram/Telegram`,
    link,
    workdir: `${REMOTE_ROOT}/desktop`,
  });
}

async function viewSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const messageId = opts.messageId;
  if (!messageId) {
    throw new Error("view requires --message-id.");
  }
  const link = telegramPrivatePostLink(session.credential.groupId, messageId);
  const logPath = path.join(
    session.outputDir,
    `proof-view-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`,
  );
  await sshRun(root, session.crabbox.inspect, renderProofViewCommand(link), {
    outputFile: logPath,
  });
  return {
    crop: TELEGRAM_DESKTOP_CROP,
    geometry: TELEGRAM_DESKTOP_WINDOW,
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
    sutAttestation: session.localSut.sutAttestation,
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
  let desktopSessionTerminationAttempted = false;
  const terminateDesktopSession = async () => {
    if (opts.keepBox || desktopSessionTerminationAttempted) {
      return;
    }
    desktopSessionTerminationAttempted = true;
    await terminateRemoteDesktopSession(root, session.crabbox.inspect).catch((error: unknown) => {
      summary.desktopSessionTerminateError = coerceErrorMessage(error);
    });
  };
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
    await terminateDesktopSession();
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
    let sutQuiesced = false;
    try {
      await stopLocalSutDaemon(session.localSut);
      sutQuiesced = true;
    } catch (error) {
      summary.sutStopError = coerceErrorMessage(error);
      summary.status = "fail";
    }
    if (sutQuiesced) {
      try {
        preserveLocalSutRuntimeArtifacts(session.localSut, session.outputDir);
      } catch (error) {
        summary.runtimeArtifactError = coerceErrorMessage(error);
        summary.status = "fail";
      }
    }
    try {
      destroyLocalSutRuntime(session.localSut);
    } catch (error) {
      summary.sutDestroyError = coerceErrorMessage(error);
      summary.status = "fail";
    }
    if (session.localSut.funnelBridge) {
      await stopTailscaleFunnelBridge(root, session.localSut.funnelBridge).catch(
        (error: unknown) => {
          summary.funnelResetError = coerceErrorMessage(error);
        },
      );
    }
    await terminateDesktopSession();
    await releaseCredential(root, opts, session.credential.leaseFile).catch((error: unknown) => {
      summary.credentialReleaseError = coerceErrorMessage(error);
    });
    if (session.crabbox.createdLease && !opts.keepBox) {
      await stopCrabbox(root, opts, session.crabbox.id).catch((error: unknown) => {
        summary.crabboxStopError = coerceErrorMessage(error);
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
    ? stageFullSessionArtifacts(session.outputDir)
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
  if (opts.command === "inspect") {
    console.log(JSON.stringify(await inspectSessionIdentity(root, opts, outputDir), null, 2));
    return;
  }
  if (opts.command === "restart") {
    console.log(JSON.stringify(await restartSessionGateway(root, opts, outputDir), null, 2));
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
    const roleSecret =
      opts.credentialRole === "ci"
        ? process.env.OPENCLAW_QA_CONVEX_SECRET_CI
        : process.env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER;
    const hasConvexEnv =
      trimToValue(process.env.OPENCLAW_QA_CONVEX_SITE_URL) && trimToValue(roleSecret);
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
    const authorizeScript = path.join(localRoot, "authorize-desktop.sh");
    const selectChatScript = path.join(localRoot, "select-desktop-chat.sh");
    const probeScript = path.join(localRoot, "remote-probe.sh");
    await writeExecutable(
      setupScript,
      renderRemoteSetup({ tdlibSha256: opts.tdlibSha256, tdlibUrl: opts.tdlibUrl }),
    );
    await writeExecutable(launchScript, renderLaunchDesktop());
    await writeExecutable(authorizeScript, renderAuthorizeDesktop());
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
    await scpToRemote(root, inspect, authorizeScript, `${REMOTE_ROOT}/authorize-desktop.sh`);
    await scpToRemote(root, inspect, selectChatScript, `${REMOTE_ROOT}/select-desktop-chat.sh`);
    await scpToRemote(root, inspect, probeScript, `${REMOTE_ROOT}/remote-probe.sh`);
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/remote-setup.sh`, {
      timeoutMs: REMOTE_SETUP_COMMAND_TIMEOUT_MS,
    });

    const sutRuntime = await startLocalSut({
      gatewayPort: opts.gatewayPort,
      groupId: credential.groupId,
      humanDelayFixedMs: opts.humanDelayFixedMs,
      linkPreview: opts.linkPreview,
      mockResponseText: opts.mockResponseText,
      mockResponseChunkDelayMs: opts.mockResponseChunkDelayMs,
      mockPort: opts.mockPort,
      outputDir,
      nodeBin: opts.nodeBin,
      pnpmBin: opts.pnpmBin,
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
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/authorize-desktop.sh`);
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/select-desktop-chat.sh`);
    const videoPath = path.join(outputDir, "telegram-user-crabbox-proof.mp4");
    await recordProbeVideo({
      crabboxBin: opts.crabboxBin,
      cwd: root,
      durationSeconds: opts.recordSeconds,
      leaseId,
      outputPath: videoPath,
      provider: opts.provider,
      runProbe: async () => {
        await sshRun(root, inspect, `bash ${REMOTE_ROOT}/remote-probe.sh`);
      },
      target: opts.target,
    });
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
        summary.credentialReleaseError = coerceErrorMessage(error);
      });
    }
    if (leaseId && createdLease && !opts.keepBox) {
      await stopCrabbox(root, opts, leaseId).catch((error: unknown) => {
        summary.crabboxStopError = coerceErrorMessage(error);
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

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url),
  );
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(coerceErrorMessage(error));
    process.exit(1);
  });
}
