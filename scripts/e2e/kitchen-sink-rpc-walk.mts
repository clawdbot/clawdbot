// Walks the kitchen-sink gateway RPC scenario for E2E smoke coverage.
import childProcess, {
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { appendBoundedTail } from "../lib/bounded-output-tail.mjs";
import {
  createBoundedResponseTooLargeError,
  readBoundedResponseText,
} from "../lib/bounded-response.mjs";
import { toErrorObject as coerceKitchenSinkError } from "../lib/error-format.mts";
import {
  resolveWindowsPowerShellPath,
  resolveWindowsSystem32Path,
  resolveWindowsTaskkillPath,
} from "../lib/windows-taskkill.mjs";
import { fixtureCapabilityConsentArgs } from "./lib/package-compat.mjs";
import { readTextFileTail } from "./lib/text-file-utils.mjs";

type JsonRecord = Record<string, unknown>;
type ProcessEnv = Record<string, string | undefined>;
type KitchenSinkEnv = {
  [key: string]: string | undefined;
  OPENCLAW_CONFIG_PATH: string;
};
type CapturedOutput = { text: string; truncatedChars: number };
type CommandChild = ChildProcess;
type ProcessTreeTarget = Pick<CommandChild, "exitCode" | "kill" | "pid" | "signalCode">;
type OpenClawRunner =
  | { baseArgs: string[]; command: string; label?: string; pnpm?: never }
  | { baseArgs: string[]; label?: string; pnpm: true; command?: never };
type TaskkillRunner = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => { error?: Error; status: number | null };
type ProcessSample = {
  aggregateRssMiB?: number;
  cpuPercent?: number | null;
  cpuSeconds?: number | null;
  processId?: number;
  rssMiB: number;
};
type TimedProcessSample = ProcessSample & { elapsedMs: number; label: string };
type CommandRunner = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<{ stderr: string; stdout: string }>;
type SampleProcessOptions = {
  platform?: NodeJS.Platform;
  posixCommandLineNeedles?: string[];
  runCommand?: CommandRunner;
  windowsCommandLineNeedles?: string[];
};
interface RunCommandOptions extends SpawnOptions {
  outputCaptureChars?: number;
  requireResourceSample?: boolean;
  resourceLabel?: string;
  resourceSampleIntervalMs?: number;
  resourceSampleOptions?: SampleProcessOptions;
  resourceSamples?: unknown[];
  sampleProcessImpl?: typeof sampleProcess;
  timeoutKillGraceMs?: number;
  timeoutMs?: number;
}
type RunCommandResult = {
  stderr: string;
  stderrTruncatedChars: number;
  stdout: string;
  stdoutTruncatedChars: number;
};
type FetchImplementation = (input: string, init?: RequestInit) => unknown;
type FetchJsonOptions = {
  attempts?: number;
  fetchImpl?: FetchImplementation;
  maxBodyBytes?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};
type RpcCallOptions = {
  commandResourceOptions?: RunCommandOptions;
  env: KitchenSinkEnv;
  port: number;
  runner: OpenClawRunner;
};
type GatewayChild = {
  exitCode?: number | null;
  kill: (signal?: NodeJS.Signals) => unknown;
  pid?: number;
  signalCode?: string | null;
};
type KillProcess = (pid: number, signal: string | number) => boolean;
type GatewaySignalTarget = Pick<GatewayChild, "kill" | "pid">;
type GatewayStatusChild = Pick<GatewayChild, "exitCode" | "signalCode">;
type GatewayRequestError = Error & {
  details?: unknown;
  gatewayCode: string;
  retryAfterMs?: number;
  retryable: boolean;
};
type PosixProcessRow = {
  command: string;
  cpuPercent: number | null;
  parentProcessId: number;
  processId: number;
  rssKb: number;
};
type MalformedProcessRow = { pidRaw: string; ppidRaw: string };

const PLUGIN_SPEC =
  process.env.OPENCLAW_KITCHEN_SINK_NPM_SPEC || "npm:@openclaw/kitchen-sink@latest";
const PLUGIN_ID = process.env.OPENCLAW_KITCHEN_SINK_PLUGIN_ID || "openclaw-kitchen-sink-fixture";
const CHANNEL_ID = "kitchen-sink-channel";
const CHANNEL_ACCOUNT_ID = "local";
const TOKEN = "kitchen-sink-rpc-token";
const SESSION_KEY = "agent:main:kitchen-sink-rpc";
const EXPECTED_COMMANDS = ["kitchen", "kitchen-sink"];
const EXPECTED_TOOLS = ["kitchen_sink_text", "kitchen_sink_search", "kitchen_sink_image_job"];
const EXPECTED_PROVIDERS = ["kitchen-sink-provider", "kitchen-sink-llm"];
const EXPECTED_SPEECH_PROVIDERS = ["kitchen-sink-speech", "kitchen-sink-speech-provider"];
const DEFAULT_READY_TIMEOUT_MS = 240000;
const DEFAULT_COMMAND_TIMEOUT_MS = 180000;
const DEFAULT_INSTALL_TIMEOUT_MS = 600000;
const DEFAULT_RPC_TIMEOUT_MS = 60000;
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_FETCH_BODY_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_RSS_MIB = 2048;
const DEFAULT_MAX_COMMAND_RSS_MIB = 8192;
const DEFAULT_OUTPUT_CAPTURE_CHARS = 1024 * 1024;
export const MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS = 2_147_000_000;
const GATEWAY_TEARDOWN_GRACE_MS = 10000;
const GATEWAY_TEARDOWN_KILL_GRACE_MS = 2000;
const COMMAND_PARENT_SIGNAL_KILL_GRACE_MS = 2000;
const COMMAND_PROCESS_TREE_EXIT_POLL_MS = 50;
const LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const LOG_SCAN_MAX_LINE_CHARS = 16 * 1024;
const LOG_TAIL_BYTES = 256 * 1024;
const JSON_PREVIEW_STRING_HEAD_CHARS = 256;
const JSON_PREVIEW_STRING_TAIL_CHARS = 256;
const JSON_PREVIEW_ARRAY_ITEMS = 20;
const JSON_PREVIEW_OBJECT_KEYS = 40;
const JSON_PREVIEW_MAX_DEPTH = 4;
const POSIX_PROCESS_SNAPSHOT_ARGS = ["-ww", "-axo", "pid=,ppid=,rss=,pcpu=,command="];
const ERROR_LOG_DENY_PATTERNS = [
  /\buncaught exception\b/iu,
  /\bunhandled rejection\b/iu,
  /\bfatal\b/iu,
  /\bpanic\b/iu,
  /\blevel["']?\s*:\s*["']error["']/iu,
  /\[(?:error|ERROR)\]/u,
];
const ERROR_LOG_ALLOW_PATTERNS = [
  /^\s*0 errors?\s*$/iu,
  /^\s*expected no diagnostics errors?\s*$/iu,
  /^\s*diagnostics errors?:\s*$/iu,
];

let callGatewayModulePromise:
  | Promise<{
      callGateway: (options: JsonRecord) => Promise<unknown>;
    }>
  | null
  | undefined;
const activeCommandChildren = new Set<CommandChild>();
const commandParentSignals: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
let commandShutdownPromise: Promise<void[]> | undefined;
let commandSignalHandlersInstalled = false;

function installCommandSignalHandlers() {
  if (commandSignalHandlersInstalled) {
    return;
  }
  commandSignalHandlersInstalled = true;
  for (const signal of commandParentSignals) {
    const handler = commandSignalHandlers.get(signal);
    if (handler) {
      process.on(signal, handler);
    }
  }
}

function removeCommandSignalHandlers() {
  if (!commandSignalHandlersInstalled) {
    return;
  }
  commandSignalHandlersInstalled = false;
  for (const signal of commandParentSignals) {
    const handler = commandSignalHandlers.get(signal);
    if (handler) {
      process.off(signal, handler);
    }
  }
}

const commandSignalHandlers = new Map(
  commandParentSignals.map((signal) => [
    signal,
    () => {
      void shutdownActiveCommands(signal);
    },
  ]),
);

function usage() {
  return `Usage: node --import tsx scripts/e2e/kitchen-sink-rpc-walk.mts

Runs the external Kitchen Sink plugin RPC walk against a built OpenClaw entry.

Environment:
  OPENCLAW_ENTRY                         Built OpenClaw entrypoint. Defaults to dist/index.mjs or dist/index.js.
  OPENCLAW_KITCHEN_SINK_NPM_SPEC         Plugin package spec. Default: npm:@openclaw/kitchen-sink@latest.
  OPENCLAW_KITCHEN_SINK_PLUGIN_ID        Plugin id. Default: openclaw-kitchen-sink-fixture.
  OPENCLAW_KITCHEN_SINK_PERSONALITY      Plugin fixture personality. Default: conformance.
  OPENCLAW_KITCHEN_SINK_RPC_PORT         Gateway loopback port. Default: OS-selected free port.
  OPENCLAW_KITCHEN_SINK_RPC_READY_MS     Gateway readiness timeout.
  OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS   OpenClaw command timeout.
  OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS   Plugin install timeout.
  OPENCLAW_KITCHEN_SINK_RPC_CALL_MS      RPC call timeout.
  OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS     HTTP readiness probe timeout.
  OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES  HTTP readiness probe response ceiling.
  OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB      Gateway RSS ceiling.
  OPENCLAW_KITCHEN_SINK_COMMAND_MAX_RSS_MIB  Install/CLI command RSS ceiling.
  OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS  Per-command stdout/stderr capture ceiling.
  OPENCLAW_KITCHEN_SINK_KEEP_TMP=1       Preserve the isolated temp home.
`;
}

export function shouldPrintHelp(argv: string[]) {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

export function validateCliArgs(argv: string[]) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

export function readPositiveInt(raw: string | undefined, fallback: number, label = "value") {
  const text = (raw || "").trim();
  if (!text) {
    return fallback;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(text)}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(text)}`);
  }
  return parsed;
}

function clampKitchenSinkTimerTimeoutMs(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
}

export function readPositiveTimerMs(raw: string | undefined, fallback: number, label = "value") {
  return clampKitchenSinkTimerTimeoutMs(readPositiveInt(raw, fallback, label));
}

export function resolveKitchenSinkRpcConfig(env: ProcessEnv = process.env) {
  const commandTimeoutMs = readPositiveTimerMs(
    env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS,
    DEFAULT_COMMAND_TIMEOUT_MS,
    "OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS",
  );
  return {
    commandMaxRssMiB: readPositiveInt(
      env.OPENCLAW_KITCHEN_SINK_COMMAND_MAX_RSS_MIB,
      DEFAULT_MAX_COMMAND_RSS_MIB,
      "OPENCLAW_KITCHEN_SINK_COMMAND_MAX_RSS_MIB",
    ),
    commandTimeoutMs,
    fetchBodyMaxBytes: readPositiveInt(
      env.OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES,
      DEFAULT_FETCH_BODY_MAX_BYTES,
      "OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES",
    ),
    fetchTimeoutMs: readPositiveTimerMs(
      env.OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS,
      DEFAULT_FETCH_TIMEOUT_MS,
      "OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS",
    ),
    installTimeoutMs: readPositiveTimerMs(
      env.OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS,
      Math.max(commandTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS),
      "OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS",
    ),
    maxRssMiB: readPositiveInt(
      env.OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB,
      DEFAULT_MAX_RSS_MIB,
      "OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB",
    ),
    outputCaptureChars: readPositiveInt(
      env.OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS,
      DEFAULT_OUTPUT_CAPTURE_CHARS,
      "OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS",
    ),
    readyTimeoutMs: readPositiveTimerMs(
      env.OPENCLAW_KITCHEN_SINK_RPC_READY_MS,
      DEFAULT_READY_TIMEOUT_MS,
      "OPENCLAW_KITCHEN_SINK_RPC_READY_MS",
    ),
    rpcTimeoutMs: readPositiveTimerMs(
      env.OPENCLAW_KITCHEN_SINK_RPC_CALL_MS,
      DEFAULT_RPC_TIMEOUT_MS,
      "OPENCLAW_KITCHEN_SINK_RPC_CALL_MS",
    ),
  };
}

async function findAvailableLoopbackPort(options: { createServer?: typeof net.createServer } = {}) {
  const createServer = options.createServer ?? (() => net.createServer());
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    const fail = (error: unknown) => {
      server.close?.(() => {});
      const reservationError: Error = coerceKitchenSinkError(
        error,
        "Unable to reserve Kitchen Sink RPC loopback port",
      );
      reject(reservationError);
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off?.("error", fail);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          const closeError: Error = coerceKitchenSinkError(
            error,
            "Unable to close Kitchen Sink RPC loopback port",
          );
          reject(closeError);
          return;
        }
        if (!Number.isSafeInteger(port) || port <= 0) {
          reject(new Error(`unable to reserve Kitchen Sink RPC loopback port: ${String(port)}`));
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function resolveKitchenSinkRpcPort(
  env: ProcessEnv = process.env,
  options: { findAvailablePort?: () => Promise<number> } = {},
) {
  const rawPort = (env.OPENCLAW_KITCHEN_SINK_RPC_PORT || "").trim();
  if (rawPort) {
    const port = readPositiveInt(rawPort, 0, "OPENCLAW_KITCHEN_SINK_RPC_PORT");
    if (port > 65535) {
      throw new Error(
        `OPENCLAW_KITCHEN_SINK_RPC_PORT must be a TCP port from 1 to 65535. Got: ${JSON.stringify(rawPort)}`,
      );
    }
    return port;
  }
  return await (options.findAvailablePort ?? findAvailableLoopbackPort)();
}

function resolveOpenClawRunner(): OpenClawRunner {
  if (process.env.OPENCLAW_ENTRY) {
    return {
      command: "node",
      baseArgs: [process.env.OPENCLAW_ENTRY],
      label: process.env.OPENCLAW_ENTRY,
    };
  }
  for (const candidate of ["dist/index.mjs", "dist/index.js"]) {
    const resolved = path.join(process.cwd(), candidate);
    if (fs.existsSync(resolved)) {
      return { command: "node", baseArgs: [resolved], label: resolved };
    }
  }
  return { pnpm: true, baseArgs: ["openclaw"], label: "pnpm openclaw" };
}

export function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kitchen-sink-rpc-"));
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_SKIP_PROVIDERS: "0",
      OPENCLAW_KITCHEN_SINK_PERSONALITY:
        process.env.OPENCLAW_KITCHEN_SINK_PERSONALITY || "conformance",
    },
  };
}

export async function cleanupKitchenSinkEnv(
  root: string,
  options: { attempts?: number; delayMs?: number; throwOnFailure?: boolean; warn?: boolean } = {},
) {
  if (root) {
    const attempts = Math.max(1, options.attempts ?? 5);
    const delayMs = Math.max(0, options.delayMs ?? 250);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await delay(delayMs);
        }
      }
    }
    if (options.warn !== false) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      console.error(`Kitchen Sink RPC temp root cleanup failed; preserved ${root}: ${message}`);
    }
    if (options.throwOnFailure) {
      throw new Error(`failed to remove Kitchen Sink RPC temp root: ${root}`, {
        cause: lastError,
      });
    }
    return false;
  }
  return true;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function formatCapturedOutput(label: string, buffer: CapturedOutput) {
  return buffer.truncatedChars > 0
    ? `[${label} truncated ${buffer.truncatedChars} chars]\n${buffer.text}`
    : buffer.text;
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  if (commandShutdownPromise) {
    return commandShutdownPromise.then(() => {
      throw new Error(`${command} ${args.join(" ")} skipped during parent signal shutdown`);
    });
  }
  return new Promise<RunCommandResult>((resolve, reject) => {
    const config = resolveKitchenSinkRpcConfig();
    const {
      resourceLabel,
      resourceSampleIntervalMs = 1000,
      resourceSampleOptions,
      resourceSamples,
      outputCaptureChars = config.outputCaptureChars,
      requireResourceSample = false,
      sampleProcessImpl = sampleProcess,
      timeoutKillGraceMs = 2000,
      timeoutMs = config.commandTimeoutMs,
      ...spawnOptions
    } = options;
    const resolvedTimeoutMs = clampKitchenSinkTimerTimeoutMs(timeoutMs);
    const resolvedTimeoutKillGraceMs = clampKitchenSinkTimerTimeoutMs(timeoutKillGraceMs);
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
      detached: spawnOptions.detached ?? process.platform !== "win32",
    });
    activeCommandChildren.add(child);
    installCommandSignalHandlers();
    const startedAt = Date.now();
    let stdout = { text: "", truncatedChars: 0 };
    let stderr = { text: "", truncatedChars: 0 };
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillAt: number | undefined;
    let sampleTimer: ReturnType<typeof setInterval> | undefined;
    let resourceSampleInFlight: Promise<void> | null = null;
    let capturedResourceSampleCount = 0;
    let lastResourceSampleError: unknown;
    const commandLabel = resourceLabel ?? [command, ...args.slice(0, 2)].join(" ");
    const shouldSampleResources = Array.isArray(resourceSamples);
    const collectResourceSample = () => {
      if (!shouldSampleResources || !child.pid) {
        return null;
      }
      const childPid = child.pid;
      resourceSampleInFlight ??= Promise.resolve()
        .then(() => sampleProcessImpl(childPid, resourceSampleOptions ?? {}))
        .then((sample) => {
          if (sample) {
            capturedResourceSampleCount += 1;
            resourceSamples.push({
              ...sample,
              elapsedMs: Date.now() - startedAt,
              label: commandLabel,
            });
          }
        })
        .catch((error: unknown) => {
          lastResourceSampleError = error;
        })
        .finally(() => {
          resourceSampleInFlight = null;
        });
      return resourceSampleInFlight;
    };
    const stopResourceSampling = async () => {
      clearInterval(sampleTimer);
      await resourceSampleInFlight?.catch(() => {});
      if (requireResourceSample && capturedResourceSampleCount === 0) {
        const detail =
          lastResourceSampleError instanceof Error ? `: ${lastResourceSampleError.message}` : "";
        return new Error(`${commandLabel} RSS sample was not captured${detail}`);
      }
      return null;
    };
    if (shouldSampleResources) {
      void collectResourceSample();
      sampleTimer = setInterval(
        () => {
          void collectResourceSample();
        },
        Math.max(100, resourceSampleIntervalMs),
      );
      sampleTimer.unref?.();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      forceKillAt = Date.now() + resolvedTimeoutKillGraceMs;
      forceKillTimer = setTimeout(
        () => signalProcessGroup(child, "SIGKILL"),
        resolvedTimeoutKillGraceMs,
      );
      forceKillTimer.unref();
    }, resolvedTimeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedTail(stdout, chunk, outputCaptureChars);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedTail(stderr, chunk, outputCaptureChars);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      forceKillAt = undefined;
      releaseCommandChild(child);
      const commandError: Error = coerceKitchenSinkError(error, "Command failed before exit");
      void stopResourceSampling().finally(() => reject(commandError));
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      const finish = () => {
        clearTimeout(forceKillTimer);
        forceKillAt = undefined;
        releaseCommandChild(child);
        void stopResourceSampling().then((resourceSampleFailure) => {
          if (!timedOut && status === 0) {
            if (resourceSampleFailure) {
              reject(resourceSampleFailure);
              return;
            }
            resolve({
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutTruncatedChars: stdout.truncatedChars,
              stderrTruncatedChars: stderr.truncatedChars,
            });
            return;
          }
          const detail = [
            formatCapturedOutput("stdout", stdout),
            formatCapturedOutput("stderr", stderr),
          ]
            .filter(Boolean)
            .join("\n")
            .trim();
          const failure = timedOut
            ? `timed out after ${resolvedTimeoutMs}ms`
            : `failed with ${signal || status}`;
          reject(
            Object.assign(
              new Error(
                `${command} ${args.join(" ")} ${failure}${detail ? `\n${tailText(detail)}` : ""}`,
              ),
              {
                signal,
                status,
                stderr: stderr.text,
                stdout: stdout.text,
              },
            ),
          );
        });
      };

      if (timedOut) {
        void finishTimedOutCommandProcessTree(child, {
          forceKillAt,
          timeoutKillGraceMs: resolvedTimeoutKillGraceMs,
        }).then(finish, finish);
        return;
      }

      finish();
    });
  });
}

async function finishTimedOutCommandProcessTree(
  child: ProcessTreeTarget,
  options: { forceKillAt?: number; timeoutKillGraceMs: number },
) {
  const { forceKillAt, timeoutKillGraceMs } = options;
  if (!commandProcessTreeIsAlive(child)) {
    return;
  }
  const graceRemainingMs =
    forceKillAt === undefined ? timeoutKillGraceMs : Math.max(0, forceKillAt - Date.now());
  if (graceRemainingMs > 0) {
    await waitForCommandProcessTreeExit(child, graceRemainingMs);
  }
  if (commandProcessTreeIsAlive(child)) {
    signalProcessGroup(child, "SIGKILL");
  }
  await waitForCommandProcessTreeExit(child, timeoutKillGraceMs);
}

function releaseCommandChild(child: CommandChild) {
  activeCommandChildren.delete(child);
  if (activeCommandChildren.size === 0 && !commandShutdownPromise) {
    removeCommandSignalHandlers();
  }
}

async function shutdownActiveCommands(signal: NodeJS.Signals) {
  if (commandShutdownPromise) {
    for (const child of activeCommandChildren) {
      signalProcessGroup(child, "SIGKILL");
    }
    return commandShutdownPromise;
  }
  const children = [...activeCommandChildren];
  const killGraceMs = resolveCommandParentSignalKillGraceMs(process.env);
  for (const child of children) {
    signalProcessGroup(child, signal);
  }
  commandShutdownPromise = Promise.all(
    children.map((child) =>
      finishTimedOutCommandProcessTree(child, {
        forceKillAt: Date.now() + killGraceMs,
        timeoutKillGraceMs: killGraceMs,
      }),
    ),
  ).finally(() => {
    removeCommandSignalHandlers();
    process.kill(process.pid, signal);
  });
  return commandShutdownPromise;
}

function resolveCommandParentSignalKillGraceMs(env: ProcessEnv) {
  const raw = env.VITEST && env.OPENCLAW_TEST_KITCHEN_SINK_PARENT_SIGNAL_KILL_GRACE_MS;
  if (!raw) {
    return COMMAND_PARENT_SIGNAL_KILL_GRACE_MS;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : COMMAND_PARENT_SIGNAL_KILL_GRACE_MS;
}

async function waitForCommandProcessTreeExit(child: ProcessTreeTarget, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!commandProcessTreeIsAlive(child)) {
      return true;
    }
    await new Promise<void>((resolvePoll) => {
      setTimeout(resolvePoll, COMMAND_PROCESS_TREE_EXIT_POLL_MS);
    });
  }
  return !commandProcessTreeIsAlive(child);
}

function commandProcessTreeIsAlive(child: ProcessTreeTarget) {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return !hasChildExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") {
      return true;
    }
    return false;
  }
}

function signalWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: TaskkillRunner = childProcess.spawnSync,
) {
  const taskkillPath = resolveWindowsTaskkillPath();
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
  return !result?.error && result?.status === 0;
}

function signalWindowsProcessTreeOrForce(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: TaskkillRunner = childProcess.spawnSync,
) {
  if (signalWindowsProcessTree(pid, signal, runTaskkill)) {
    return true;
  }
  return signal !== "SIGKILL" && signalWindowsProcessTree(pid, "SIGKILL", runTaskkill);
}

export function signalProcessGroup(
  child: { pid?: number; kill(signal?: NodeJS.Signals): unknown },
  signal: NodeJS.Signals,
  options: {
    platform?: NodeJS.Platform;
    runTaskkill?: TaskkillRunner;
    useProcessGroup?: boolean;
  } = {},
) {
  const {
    platform = process.platform,
    runTaskkill = childProcess.spawnSync,
    useProcessGroup = platform !== "win32",
  } = options;
  signalChildProcessTree(child, signal, {
    killProcess: (pid, childSignal) => process.kill(pid, childSignal),
    platform,
    runTaskkill,
    useProcessGroup,
  });
}

async function runOpenClaw(
  runner: OpenClawRunner,
  args: string[],
  env: ProcessEnv,
  options: Pick<
    RunCommandOptions,
    | "requireResourceSample"
    | "resourceLabel"
    | "resourceSampleIntervalMs"
    | "resourceSampleOptions"
    | "resourceSamples"
    | "timeoutMs"
  > = {},
) {
  const config = resolveKitchenSinkRpcConfig(env);
  const command = await resolveOpenClawCommand(runner, args, env, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return runCommand(command.command, command.args, {
    ...command.options,
    env,
    resourceLabel: options.resourceLabel,
    resourceSampleIntervalMs: options.resourceSampleIntervalMs,
    resourceSampleOptions: options.resourceSampleOptions,
    resourceSamples: options.resourceSamples,
    outputCaptureChars: config.outputCaptureChars,
    requireResourceSample: options.requireResourceSample,
    timeoutMs: options.timeoutMs ?? config.commandTimeoutMs,
  });
}

async function resolveOpenClawCommand(
  runner: OpenClawRunner,
  args: string[],
  env: ProcessEnv,
  options: { stdio?: StdioOptions } = {},
) {
  if (runner.pnpm) {
    const { createPnpmRunnerSpawnSpec } = await import("../pnpm-runner.mts");
    return createPnpmRunnerSpawnSpec({
      env,
      pnpmArgs: [...runner.baseArgs, ...args],
      stdio: options.stdio,
    });
  }
  return {
    command: runner.command,
    args: [...runner.baseArgs, ...args],
    options: { env, stdio: options.stdio },
  };
}

export function parseJsonOutput(stdout: string): JsonRecord {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("command produced no JSON output");
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to extracting a complete object from mixed command output.
  }
  for (const candidate of extractBalancedJsonObjects(trimmed).toReversed()) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Continue looking for the final complete JSON object.
    }
  }
  throw new Error(`JSON output was not parseable:\n${tailText(trimmed)}`);
}

export function parseGatewayCliRequestFailure(error: unknown): GatewayRequestError | null {
  const candidate = asRecord(error);
  if (typeof candidate.stdout !== "string" || !candidate.stdout.trim()) {
    return null;
  }
  let payload;
  try {
    payload = parseJsonOutput(candidate.stdout);
  } catch {
    return null;
  }
  return payload?.ok === false ? createGatewayClientRequestError(payload.error) : null;
}

function createGatewayClientRequestError(requestError: unknown): GatewayRequestError | null {
  const candidate = asRecord(requestError);
  if (
    candidate.type !== "gateway_request_error" ||
    !hasNonEmptyString(candidate.code) ||
    !hasNonEmptyString(candidate.message) ||
    typeof candidate.retryable !== "boolean" ||
    (candidate.retryAfterMs !== undefined &&
      (typeof candidate.retryAfterMs !== "number" ||
        !Number.isInteger(candidate.retryAfterMs) ||
        candidate.retryAfterMs < 0))
  ) {
    return null;
  }
  return Object.assign(new Error(candidate.message), {
    name: "GatewayClientRequestError",
    gatewayCode: candidate.code,
    ...(candidate.details !== undefined ? { details: candidate.details } : {}),
    retryable: candidate.retryable,
    ...(candidate.retryAfterMs !== undefined ? { retryAfterMs: candidate.retryAfterMs } : {}),
  });
}

function boundedJsonPreview(value: unknown, space?: number) {
  try {
    return JSON.stringify(previewJsonValue(value), null, space) ?? String(value);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function previewJsonValue(value: unknown, depth = 0, seen = new WeakSet()): unknown {
  if (typeof value === "string") {
    return previewJsonString(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === undefined || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  if (depth >= JSON_PREVIEW_MAX_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const preview = value
        .slice(0, JSON_PREVIEW_ARRAY_ITEMS)
        .map((entry) => previewJsonValue(entry, depth + 1, seen));
      if (value.length > JSON_PREVIEW_ARRAY_ITEMS) {
        preview.push(`[${value.length - JSON_PREVIEW_ARRAY_ITEMS} more item(s)]`);
      }
      return preview;
    }

    const preview: JsonRecord = {};
    const record = asRecord(value);
    let included = 0;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      if (included >= JSON_PREVIEW_OBJECT_KEYS) {
        preview.truncatedKeys = "more keys omitted";
        break;
      }
      preview[key] = previewJsonValue(record[key], depth + 1, seen);
      included += 1;
    }
    return preview;
  } finally {
    seen.delete(value);
  }
}

function previewJsonString(value: string) {
  const limit = JSON_PREVIEW_STRING_HEAD_CHARS + JSON_PREVIEW_STRING_TAIL_CHARS;
  if (value.length <= limit) {
    return value;
  }
  const omitted = value.length - limit;
  return `${value.slice(0, JSON_PREVIEW_STRING_HEAD_CHARS)}... [truncated ${omitted} chars] ...${value.slice(
    -JSON_PREVIEW_STRING_TAIL_CHARS,
  )}`;
}

function extractBalancedJsonObjects(text: string) {
  const candidates: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
      continue;
    }
    if (!isJsonObjectRecordStart(text, index)) {
      continue;
    }
    const end = findBalancedJsonObjectEnd(text, index);
    if (end > index) {
      candidates.push(text.slice(index, end + 1));
      index = end;
    }
  }
  return candidates;
}

function isJsonObjectRecordStart(text: string, index: number) {
  if (index === 0) {
    return true;
  }
  let cursor = index - 1;
  while (cursor >= 0 && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor -= 1;
  }
  return cursor < 0 || text[cursor] === "\n" || text[cursor] === "\r";
}

function findBalancedJsonObjectEnd(text: string, startIndex: number) {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function hasOwnPayloadField(raw: unknown, field: string): raw is JsonRecord {
  return (
    ((typeof raw === "object" && raw !== null) || typeof raw === "function") &&
    Object.hasOwn(raw, field)
  );
}

export function unwrapRpcPayload(raw: unknown): unknown {
  const envelope = asRecord(raw);
  if (envelope.ok === false) {
    const requestError = createGatewayClientRequestError(envelope.error);
    if (requestError) {
      throw requestError;
    }
    throw new Error(`gateway RPC failed: ${boundedJsonPreview(envelope.error ?? raw)}`);
  }
  if (
    hasOwnPayloadField(raw, "error") &&
    !hasOwnPayloadField(raw, "result") &&
    !hasOwnPayloadField(raw, "payload") &&
    !hasOwnPayloadField(raw, "data")
  ) {
    throw new Error(`gateway RPC returned error envelope: ${boundedJsonPreview(envelope.error)}`);
  }
  if (hasOwnPayloadField(raw, "result")) {
    return raw.result;
  }
  if (hasOwnPayloadField(raw, "payload")) {
    return raw.payload;
  }
  if (hasOwnPayloadField(raw, "data")) {
    return raw.data;
  }
  return raw;
}

async function rpcCall(method: string, params: unknown, options: RpcCallOptions) {
  const config = resolveKitchenSinkRpcConfig(options.env);
  const module = await loadCallGatewayModule(options.runner);
  const payload = module
    ? await module.callGateway({
        config: readJson(options.env.OPENCLAW_CONFIG_PATH),
        configPath: options.env.OPENCLAW_CONFIG_PATH,
        url: `ws://127.0.0.1:${options.port}`,
        token: TOKEN,
        method,
        params: params ?? {},
        timeoutMs: config.rpcTimeoutMs,
        requiredMethods: [method],
      })
    : await rpcCallViaCli(method, params, options);
  return unwrapRpcPayload(payload);
}

async function loadCallGatewayModule(runner: OpenClawRunner) {
  if (!usesBuiltOpenClawEntry(runner)) {
    return null;
  }
  callGatewayModulePromise ??= importCallGatewayModule();
  return callGatewayModulePromise;
}

async function importCallGatewayModule() {
  const distDir = path.join(process.cwd(), "dist");
  const candidates = findDistCallGatewayModuleFiles();
  for (const name of candidates) {
    const module: unknown = await import(pathToFileURL(path.join(distDir, name)).href);
    if (isCallGatewayModule(module)) {
      return module;
    }
  }
  throw new Error(`unable to find callGateway export in dist (${candidates.join(", ")})`);
}

async function rpcCallViaCli(method: string, params: unknown, options: RpcCallOptions) {
  const config = resolveKitchenSinkRpcConfig(options.env);
  let stdout;
  try {
    ({ stdout } = await runOpenClaw(
      options.runner,
      [
        "gateway",
        "call",
        method,
        "--url",
        `ws://127.0.0.1:${options.port}`,
        "--token",
        TOKEN,
        "--timeout",
        String(config.rpcTimeoutMs),
        "--json",
        "--params",
        JSON.stringify(params ?? {}),
      ],
      options.env,
      createRpcCliRunOptions(method, options),
    ));
  } catch (error) {
    throw parseGatewayCliRequestFailure(error) ?? error;
  }
  return parseJsonOutput(stdout);
}

export function createRpcCliRunOptions(
  method: string,
  options: { commandResourceOptions?: RunCommandOptions; env?: ProcessEnv } = {},
) {
  const config = resolveKitchenSinkRpcConfig(options.env);
  return {
    ...options.commandResourceOptions,
    resourceLabel: `gateway call ${method}`,
    timeoutMs: clampKitchenSinkTimerTimeoutMs(config.rpcTimeoutMs + 30000),
  };
}

export function findDistCallGatewayModuleFiles(cwd = process.cwd()) {
  const distDir = path.join(cwd, "dist");
  return fs.existsSync(distDir)
    ? fs
        .readdirSync(distDir)
        .filter((name) => /^call(?:\.runtime)?-[A-Za-z0-9_-]+\.m?js$/u.test(name))
        .toSorted((left, right) => left.localeCompare(right))
    : [];
}

export function usesBuiltOpenClawEntry(
  runner: OpenClawRunner,
  cwd = process.cwd(),
  env: ProcessEnv = process.env,
) {
  if (runner?.pnpm || !runner?.baseArgs?.[0]) {
    return false;
  }
  const entry = runner.baseArgs[0];
  if (env.OPENCLAW_ENTRY && entry === env.OPENCLAW_ENTRY) {
    return true;
  }
  const relative = path.relative(path.resolve(cwd, "dist"), path.resolve(cwd, entry));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function retryRpcCall(method: string, params: unknown, options: RpcCallOptions) {
  const started = Date.now();
  const config = resolveKitchenSinkRpcConfig(options.env);
  let lastError: unknown;
  while (Date.now() - started < config.readyTimeoutMs) {
    try {
      return await rpcCall(method, params, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableGatewayCallError(error)) {
        throw error;
      }
      await delay(500);
    }
  }
  throw coerceKitchenSinkError(
    lastError ?? new Error(`gateway RPC ${method} timed out before retry`),
    "Non-Error thrown",
  );
}

function isRetryableGatewayCallError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    isRetryableTransientNetworkError(error) ||
    text.includes("gateway starting") ||
    text.includes("gateway closed") ||
    text.includes("handshake timeout") ||
    text.includes("GatewayTransportError")
  );
}

function isRetryableTransientNetworkError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error;
  const message =
    candidate instanceof Error ? candidate.message : typeof candidate === "string" ? candidate : "";
  const code = asRecord(candidate).code;
  const text = `${typeof code === "string" ? code : ""} ${message}`;
  if (
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH)\b/iu.test(text) ||
    /\b(?:fetch failed|socket hang up|connection reset)\b/iu.test(text)
  ) {
    return true;
  }
  if (typeof candidate === "object" && candidate !== null && "cause" in candidate) {
    return isRetryableTransientNetworkError(candidate.cause, seen);
  }
  return false;
}

export async function fetchJson(url: string | URL, options: FetchJsonOptions = {}) {
  const config = resolveKitchenSinkRpcConfig();
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = clampKitchenSinkTimerTimeoutMs(options.timeoutMs ?? config.fetchTimeoutMs);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? config.fetchBodyMaxBytes);
  const externalSignal = options.signal;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error(`fetch ${url} timed out after ${timeoutMs}ms`), {
      code: "ETIMEDOUT",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbort = () => {};
    const abortPromise = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const error = getExternalAbortReason(externalSignal);
            controller.abort(error);
            reject(createExternalAbortError(externalSignal));
          };
          if (externalSignal.aborted) {
            onAbort();
            return;
          }
          externalSignal.addEventListener("abort", onAbort, { once: true });
          removeExternalAbort = () => externalSignal.removeEventListener("abort", onAbort);
        })
      : null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
      timeout.unref?.();
    });
    try {
      const responseValue: unknown = await Promise.race([
        Promise.resolve((options.fetchImpl ?? fetch)(String(url), { signal: controller.signal })),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (!(responseValue instanceof Response)) {
        throw new Error("fetch implementation returned an invalid response");
      }
      const response = responseValue;
      const bodyAbortPromise = abortPromise
        ? Promise.race([timeoutPromise, abortPromise])
        : timeoutPromise;
      const text = await Promise.race([
        readBoundedResponseText(response, "fetch", maxBodyBytes, {
          createTooLargeError: createBoundedResponseTooLargeError,
          timeoutPromise: bodyAbortPromise,
        }),
        bodyAbortPromise,
      ]);
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableTransientNetworkError(error)) {
        throw error;
      }
      await delayWithAbort(options.retryDelayMs ?? 250, externalSignal);
    } finally {
      removeExternalAbort();
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
  throw coerceKitchenSinkError(lastError ?? new Error(`fetch ${url} failed`), "Non-Error thrown");
}

function getExternalAbortReason(signal: AbortSignal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("fetch aborted");
}

function createExternalAbortError(signal: AbortSignal) {
  const reason = getExternalAbortReason(signal);
  return new Error(reason.message, { cause: reason });
}

async function delayWithAbort(delayMs: number, signal?: AbortSignal) {
  if (!signal) {
    await delay(delayMs);
    return;
  }
  if (signal.aborted) {
    throw createExternalAbortError(signal);
  }
  try {
    await delay(delayMs, undefined, { signal });
  } catch (error) {
    if (signal.aborted) {
      throw createExternalAbortError(signal);
    }
    throw error;
  }
}

function configureKitchenSink(env: KitchenSinkEnv, port: number) {
  const configPath = env.OPENCLAW_CONFIG_PATH;
  const config = asRecord(fs.existsSync(configPath) ? readJson(configPath) : {});
  const gateway = asRecord(config.gateway);
  const plugins = asRecord(config.plugins);
  const pluginEntries = asRecord(plugins.entries);
  const pluginEntry = asRecord(pluginEntries[PLUGIN_ID]);
  const tools = asRecord(config.tools);
  const tts = asRecord(config.tts);
  const ttsProviders = asRecord(tts.providers);
  const speechProvider = EXPECTED_SPEECH_PROVIDERS[0];
  if (!speechProvider) {
    throw new Error("Kitchen Sink speech provider fixture is missing");
  }
  config.gateway = {
    ...gateway,
    port,
    bind: "loopback",
    auth: { mode: "token", token: TOKEN },
    controlUi: {
      ...asRecord(gateway.controlUi),
      enabled: false,
    },
  };
  config.plugins = {
    ...plugins,
    enabled: true,
    allow: [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), PLUGIN_ID])],
    entries: {
      ...pluginEntries,
      [PLUGIN_ID]: {
        ...pluginEntry,
        enabled: true,
        config: {
          ...asRecord(pluginEntry.config),
          personality: env.OPENCLAW_KITCHEN_SINK_PERSONALITY,
        },
        hooks: {
          ...asRecord(pluginEntry.hooks),
          allowConversationAccess: true,
        },
      },
    },
  };
  config.channels = {
    ...asRecord(config.channels),
    [CHANNEL_ID]: { enabled: true, token: "kitchen-sink-rpc" },
  };
  config.tools = {
    ...tools,
    profile: tools.profile ?? "full",
    alsoAllow: [
      ...new Set([...(Array.isArray(tools.alsoAllow) ? tools.alsoAllow : []), ...EXPECTED_TOOLS]),
    ],
  };
  config.tts = {
    ...tts,
    provider: tts.provider ?? speechProvider,
    providers: {
      ...ttsProviders,
      [speechProvider]: {
        ...asRecord(ttsProviders[speechProvider]),
      },
    },
  };
  writeJson(configPath, config);
}

async function startGateway(
  runner: OpenClawRunner,
  port: number,
  env: ProcessEnv,
  logPath: string,
) {
  const log = fs.openSync(logPath, "w");
  const command = await resolveOpenClawCommand(
    runner,
    ["gateway", "--port", String(port), "--bind", "loopback", "--allow-unconfigured"],
    env,
    {
      stdio: ["ignore", log, log],
    },
  );
  const child = childProcess.spawn(command.command, command.args, {
    ...command.options,
    env,
    detached: process.platform !== "win32",
  });
  fs.closeSync(log);
  return child;
}

export async function stopGateway(
  child: unknown,
  options: { killGraceMs?: number; killProcess?: KillProcess; teardownGraceMs?: number } = {},
) {
  const killProcess = options.killProcess ?? defaultKillProcess;
  if (!isGatewayChild(child) || !isGatewayAlive(child, killProcess)) {
    return;
  }
  const teardownGraceMs = Math.max(0, options.teardownGraceMs ?? GATEWAY_TEARDOWN_GRACE_MS);
  const killGraceMs = Math.max(0, options.killGraceMs ?? GATEWAY_TEARDOWN_KILL_GRACE_MS);
  const exited = createChildExitPromise(child) ?? new Promise<void>(() => {});
  const waitForExit = async (ms: number) => {
    if (!isGatewayAlive(child, killProcess)) {
      return true;
    }
    await Promise.race([exited, delay(ms)]);
    return !isGatewayAlive(child, killProcess);
  };

  if (!signalGateway(child, "SIGTERM", killProcess)) {
    return;
  }
  if (await waitForExit(teardownGraceMs)) {
    return;
  }
  if (!signalGateway(child, "SIGKILL", killProcess)) {
    return;
  }
  if (await waitForExit(killGraceMs)) {
    return;
  }
  releaseUnsettledGatewayChild(child);
}

export function hasChildExited(child: unknown) {
  const candidate = asRecord(child);
  return candidate.exitCode != null || candidate.signalCode != null;
}

function defaultKillProcess(pid: number, signal: string | number) {
  return process.kill(pid, signal);
}

function isGatewayAlive(child: GatewayChild, killProcess: KillProcess) {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, 0);
      return true;
    } catch (error) {
      if (errorCode(error) === "ESRCH") {
        return false;
      }
      throw error;
    }
  }
  return !hasChildExited(child);
}

function createChildExitPromise(child: GatewayStatusChild) {
  const once = asRecord(child).once;
  if (typeof once !== "function") {
    return null;
  }
  return new Promise<void>((resolve) => {
    Reflect.apply(once, child, ["exit", () => resolve()]);
  });
}

function releaseUnsettledGatewayChild(child: GatewayChild) {
  const candidate = asRecord(child);
  for (const streamName of ["stdin", "stdout", "stderr"] as const) {
    const destroy = asRecord(candidate[streamName]).destroy;
    if (typeof destroy === "function") {
      Reflect.apply(destroy, candidate[streamName], []);
    }
  }
  if (typeof candidate.unref === "function") {
    Reflect.apply(candidate.unref, child, []);
  }
}

export function signalGateway(
  child: GatewaySignalTarget,
  signal: NodeJS.Signals,
  killProcess: KillProcess = defaultKillProcess,
  options: {
    platform?: NodeJS.Platform;
    runTaskkill?: TaskkillRunner;
    useProcessGroup?: boolean;
  } = {},
) {
  const {
    platform = process.platform,
    runTaskkill = childProcess.spawnSync,
    useProcessGroup = platform !== "win32",
  } = options;
  return signalChildProcessTree(child, signal, {
    groupEsrchMeansExited: true,
    killProcess,
    platform,
    runTaskkill,
    useProcessGroup,
  });
}

function signalChildProcessTree(
  child: GatewaySignalTarget,
  signal: NodeJS.Signals,
  options: {
    groupEsrchMeansExited?: boolean;
    killProcess: KillProcess;
    platform: NodeJS.Platform;
    runTaskkill: TaskkillRunner;
    useProcessGroup: boolean;
  },
) {
  const {
    groupEsrchMeansExited = false,
    killProcess,
    platform,
    runTaskkill,
    useProcessGroup,
  } = options;
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, signal);
      return true;
    } catch (error) {
      if (groupEsrchMeansExited && errorCode(error) === "ESRCH") {
        return false;
      }
    }
  }
  if (platform === "win32" && typeof child.pid === "number") {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return true;
    }
  }
  try {
    return child.kill(signal) !== false;
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

export function createGatewayReadyLogScanner(logPath: string, marker = "[gateway] ready") {
  let offset = 0;
  let tail = "";
  let found = false;

  return () => {
    if (found) {
      return true;
    }

    let stat;
    try {
      stat = fs.statSync(logPath);
    } catch {
      offset = 0;
      tail = "";
      return false;
    }

    if (stat.size < offset) {
      offset = 0;
      tail = "";
    }
    if (stat.size === offset) {
      return false;
    }

    const fd = fs.openSync(logPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(LOG_SCAN_CHUNK_BYTES, stat.size - offset));
      while (offset < stat.size) {
        const bytesToRead = Math.min(buffer.length, stat.size - offset);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        offset += bytesRead;
        const text = `${tail}${buffer.subarray(0, bytesRead).toString("utf8")}`;
        if (text.includes(marker)) {
          found = true;
          return true;
        }
        tail = text.slice(-Math.max(0, marker.length - 1));
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  };
}

export async function waitForGatewayReady(
  child: GatewayStatusChild,
  port: number,
  logPath: string,
  options: { fetchImpl?: FetchImplementation; pollDelayMs?: number; timeoutMs?: number } = {},
) {
  const config = resolveKitchenSinkRpcConfig();
  const started = Date.now();
  let lastError = "";
  const timeoutMs = clampKitchenSinkTimerTimeoutMs(options.timeoutMs ?? config.readyTimeoutMs);
  const pollDelayMs = Math.max(1, options.pollDelayMs ?? 250);
  const logReportedReady = createGatewayReadyLogScanner(logPath);
  const childExit = createChildExitPromise(child);
  const exitedBeforeReadyError = () =>
    new Error(`gateway exited before ready\n${tailFile(logPath)}`);
  if (hasChildExited(child)) {
    throw exitedBeforeReadyError();
  }
  while (Date.now() - started < timeoutMs) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
    if (hasChildExited(child)) {
      throw exitedBeforeReadyError();
    }
    const probeAbort = new AbortController();
    const readyzProbe = (async () => {
      try {
        const readyz = await fetchJson(`http://127.0.0.1:${port}/readyz`, {
          attempts: 1,
          fetchImpl: options.fetchImpl,
          signal: probeAbort.signal,
          timeoutMs: Math.min(config.fetchTimeoutMs, remainingMs),
        });
        return { kind: "readyz" as const, readyz };
      } catch (error) {
        return { kind: "error" as const, error };
      }
    })();
    const outcome = await Promise.race([
      readyzProbe,
      ...(childExit ? [childExit.then(() => ({ kind: "child-exit" as const }))] : []),
    ]);
    if (outcome.kind === "child-exit") {
      probeAbort.abort(exitedBeforeReadyError());
      throw exitedBeforeReadyError();
    }
    try {
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      const readyz = outcome.readyz;
      if (readyz.ok && asRecord(readyz.body).ready === true) {
        return;
      }
      lastError = `/readyz HTTP ${readyz.status} body=${boundedJsonPreview(readyz.body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (logReportedReady()) {
      lastError = `${lastError}; gateway log reported ready before HTTP readiness`;
    }
    const nextDelayMs = Math.min(pollDelayMs, Math.max(1, timeoutMs - (Date.now() - started)));
    await delay(nextDelayMs);
  }
  if (hasChildExited(child)) {
    throw new Error(`gateway exited before ready\n${tailFile(logPath)}`);
  }
  throw new Error(`gateway did not become ready: ${lastError}\n${tailFile(logPath)}`);
}

export function extractPluginCommandNames(payload: unknown) {
  const commandsValue = asRecord(payload).commands;
  const commands = Array.isArray(commandsValue) ? commandsValue : [];
  const names: unknown[] = [];
  for (const entry of commands) {
    const command = asRecord(entry);
    if (command.source !== "plugin") {
      continue;
    }
    names.push(command.name, command.nativeName);
    if (Array.isArray(command.textAliases)) {
      names.push(...command.textAliases);
    }
  }
  return names
    .filter(hasNonEmptyString)
    .map((name) => name.replace(/^\//u, ""))
    .filter((name, index, all) => all.indexOf(name) === index)
    .toSorted((left, right) => left.localeCompare(right));
}

function extractToolEntries(payload: unknown): unknown[] {
  const groupsValue = asRecord(payload).groups;
  return (Array.isArray(groupsValue) ? groupsValue : []).flatMap((group) =>
    Array.isArray(asRecord(group).tools) ? asRecord(group).tools : [],
  );
}

function assertIncludesAny(actual: string[], expected: string[], label: string) {
  if (!expected.some((value) => actual.includes(value))) {
    throw new Error(
      `${label} missing one of ${expected.join(", ")}: ${boundedJsonPreview(actual)}`,
    );
  }
}

function assertIncludesAll(actual: string[], expected: string[], label: string) {
  const missing = expected.filter((value) => !actual.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} missing ${missing.join(", ")}: ${boundedJsonPreview(actual)}`);
  }
}

export function assertExpectedKitchenSinkToolEntries(
  entries: unknown[],
  label: string,
  options: { requirePluginProvenance?: boolean } = {},
) {
  const { requirePluginProvenance = false } = options;
  const ids = entries.map((entry) => asRecord(entry).id).filter(hasNonEmptyString);
  assertIncludesAll(ids, EXPECTED_TOOLS, label);
  if (requirePluginProvenance) {
    const wrongProvenance = entries
      .filter((entry) => EXPECTED_TOOLS.includes(String(asRecord(entry).id)))
      .filter((entry) => {
        const candidate = asRecord(entry);
        return candidate.source !== "plugin" || candidate.pluginId !== PLUGIN_ID;
      })
      .map((entry) => ({
        id: asRecord(entry).id,
        pluginId: asRecord(entry).pluginId,
        source: asRecord(entry).source,
      }));
    if (wrongProvenance.length > 0) {
      throw new Error(
        `${label} plugin provenance mismatch: ${boundedJsonPreview(wrongProvenance)}`,
      );
    }
  }
  return ids;
}

export function assertChannelAccountRunning(payload: unknown) {
  const channelAccounts = asRecord(asRecord(payload).channelAccounts);
  const accounts = Array.isArray(channelAccounts[CHANNEL_ID]) ? channelAccounts[CHANNEL_ID] : [];
  const account = accounts.find((entry) => asRecord(entry).accountId === CHANNEL_ACCOUNT_ID);
  if (!account) {
    const accountIds = accounts.map((entry) => asRecord(entry).accountId).filter(hasNonEmptyString);
    throw new Error(
      `Kitchen Sink channel account ${CHANNEL_ACCOUNT_ID} was not reported. Available account ids: ${boundedJsonPreview(
        accountIds,
      )}`,
    );
  }
  const accountRecord = asRecord(account);
  if (!accountRecord.running || !accountRecord.configured) {
    throw new Error(
      `Kitchen Sink channel is not running+configured: ${boundedJsonPreview(payload)}`,
    );
  }
  return accountRecord;
}

export function assertTtsProviderCoverage(payload: unknown, surface: "providers" | "status") {
  const candidate = asRecord(payload);
  const entries =
    surface === "providers"
      ? candidate.providers
      : surface === "status"
        ? candidate.providerStates
        : null;
  if (!Array.isArray(entries)) {
    throw new Error(
      `tts.${surface} returned invalid provider list: ${boundedJsonPreview(payload)}`,
    );
  }
  const ids = entries.map((entry) => asRecord(entry).id).filter(hasNonEmptyString);
  assertIncludesAny(ids, EXPECTED_SPEECH_PROVIDERS, `tts.${surface}`);
  const configuredEntry = entries.find((entry) => {
    const provider = asRecord(entry);
    return (
      hasNonEmptyString(provider.id) &&
      EXPECTED_SPEECH_PROVIDERS.includes(provider.id) &&
      provider.configured === true
    );
  });
  if (!configuredEntry) {
    throw new Error(
      `tts.${surface} did not report a configured Kitchen Sink speech provider: ${boundedJsonPreview(
        entries,
      )}`,
    );
  }
}

export function assertKitchenSinkSearchInvokeResult(payload: unknown) {
  const candidate = asRecord(payload);
  if (candidate.ok !== true || candidate.source !== "plugin") {
    throw new Error(`Kitchen Sink search tool invoke failed: ${boundedJsonPreview(payload)}`);
  }
  const output = assertObjectPayload(candidate.output, "Kitchen Sink search tool output");
  const results = Array.isArray(output.results) ? output.results : [];
  const hasFixture = results.some(
    (entry) => asRecord(entry).title === "Kitchen Sink image fixture",
  );
  if (!hasFixture) {
    throw new Error(
      `Kitchen Sink search tool output missed expected fixture: ${boundedJsonPreview(output)}`,
    );
  }
}

export function assertKitchenSinkTextInvokeResult(payload: unknown) {
  const candidate = asRecord(payload);
  if (candidate.ok !== true || candidate.source !== "plugin") {
    throw new Error(`Kitchen Sink text tool invoke failed: ${boundedJsonPreview(payload)}`);
  }
  const output = assertObjectPayload(candidate.output, "Kitchen Sink text tool output");
  if (
    output.route !== "tool:kitchen_sink_text" ||
    typeof output.text !== "string" ||
    !output.text.includes("Kitchen Sink")
  ) {
    throw new Error(
      `Kitchen Sink text tool output missed expected fixture: ${boundedJsonPreview(output)}`,
    );
  }
}

export function assertKitchenSinkImageJobInvokeResult(payload: unknown) {
  const candidate = asRecord(payload);
  if (candidate.ok !== true || candidate.source !== "plugin") {
    throw new Error(`Kitchen Sink image job tool invoke failed: ${boundedJsonPreview(payload)}`);
  }
  const output = assertObjectPayload(candidate.output, "Kitchen Sink image job tool output");
  const image = assertObjectPayload(output.image, "Kitchen Sink image job image");
  const imageMetadata = assertObjectPayload(
    image.metadata,
    "Kitchen Sink image job image metadata",
  );
  const mediaBytes = decodePngDataUrl(output.mediaUrl);
  const mediaSha256 = mediaBytes ? createHash("sha256").update(mediaBytes).digest("hex") : "";
  if (
    output.ok !== true ||
    output.route !== "tool:kitchen_sink_image_job" ||
    asRecord(output.job).status !== "completed" ||
    asRecord(output.job).route !== "tool:kitchen_sink_image_job" ||
    !mediaBytes ||
    !hasPngSignature(mediaBytes) ||
    image.mimeType !== "image/png" ||
    imageMetadata.assetName !== "kitchen_sink_office.png" ||
    imageMetadata.width !== 1024 ||
    imageMetadata.height !== 1024 ||
    typeof imageMetadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(imageMetadata.sha256) ||
    mediaSha256 !== imageMetadata.sha256
  ) {
    throw new Error(
      `Kitchen Sink image job tool output missed expected fixture: ${boundedJsonPreview(output)}`,
    );
  }
}

function decodePngDataUrl(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0) {
    return undefined;
  }
  return Buffer.from(encoded, "base64");
}

function hasPngSignature(buffer: Buffer) {
  return buffer
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

const KITCHEN_SINK_TOOL_INVOKES = [
  {
    name: "kitchen_sink_search",
    args: { query: "kitchen sink rpc walk" },
    idempotencyKey: "kitchen-sink-rpc-search",
    assertResult: assertKitchenSinkSearchInvokeResult,
  },
  {
    name: "kitchen_sink_text",
    args: { prompt: "explain kitchen sink rpc walk" },
    idempotencyKey: "kitchen-sink-rpc-text",
    assertResult: assertKitchenSinkTextInvokeResult,
  },
  {
    name: "kitchen_sink_image_job",
    args: { prompt: "generate a kitchen sink rpc walk image" },
    idempotencyKey: "kitchen-sink-rpc-image-job",
    assertResult: assertKitchenSinkImageJobInvokeResult,
  },
];

const READ_ONLY_RPC_PROBES = [
  { method: "gateway.identity.get", params: {} },
  { method: "config.get", params: {} },
  { method: "config.schema", params: {} },
  { method: "config.schema.lookup", params: { path: "gateway" } },
  { method: "models.list", params: {} },
  { method: "models.authStatus", params: {} },
  { method: "skills.status", params: {} },
  { method: "agents.list", params: {} },
  { method: "sessions.list", params: {} },
  { method: "cron.status", params: {} },
  { method: "cron.list", params: { includeDisabled: true } },
  { method: "tasks.list", params: {} },
  { method: "usage.status", params: {} },
  { method: "usage.cost", params: {} },
  { method: "voicewake.get", params: {} },
  { method: "voicewake.routing.get", params: {} },
  { method: "tts.personas", params: {} },
  { method: "talk.catalog", params: {} },
  { method: "talk.config", params: {} },
  { method: "update.status", params: {} },
  { method: "node.list", params: {} },
  { method: "node.pair.list", params: {} },
  { method: "device.pair.list", params: {} },
  { method: "exec.approvals.get", params: {} },
  { method: "environments.list", params: {} },
  { method: "environments.status", params: { environmentId: "gateway" } },
];

const AUTHORIZATION_RPC_PROBES = [{ method: "skills.bins", params: {} }];

export function listKitchenSinkToolInvokeNames() {
  return KITCHEN_SINK_TOOL_INVOKES.map((entry) => entry.name);
}

export function listKitchenSinkReadOnlyRpcProbeNames() {
  return READ_ONLY_RPC_PROBES.map((entry) => entry.method);
}

export function listKitchenSinkAuthorizationRpcProbeNames() {
  return AUTHORIZATION_RPC_PROBES.map((entry) => entry.method);
}

export async function assertOperatorRpcDenied(
  probe: { method: string; params: JsonRecord },
  call: (method: string, params: JsonRecord) => Promise<unknown>,
) {
  try {
    await call(probe.method, probe.params);
  } catch (error) {
    const candidate = asRecord(error);
    const gatewayCode = candidate.gatewayCode;
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (gatewayCode === "INVALID_REQUEST" && message.includes("unauthorized role: operator")) {
      return;
    }
    throw error;
  }
  throw new Error(`${probe.method} unexpectedly allowed operator access`);
}

export function assertCreatedKitchenSinkSession(payload: unknown, expectedKey = SESSION_KEY) {
  const created = assertObjectPayload(payload, "sessions.create");
  if (created.ok !== true || created.key !== expectedKey || !hasNonEmptyString(created.sessionId)) {
    throw new Error(
      `sessions.create did not return the requested Kitchen Sink session: ${boundedJsonPreview(
        payload,
      )}`,
    );
  }
  return created;
}

export function assertKitchenSinkUiDescriptors(
  payload: unknown,
  options: { expectDescriptor?: boolean } = {},
) {
  const expectDescriptor = options.expectDescriptor !== false;
  const descriptorPayload = assertObjectPayload(payload, "plugins.uiDescriptors");
  if (descriptorPayload.ok !== true || !Array.isArray(descriptorPayload.descriptors)) {
    throw new Error(
      `plugins.uiDescriptors returned invalid payload: ${boundedJsonPreview(payload)}`,
    );
  }
  if (!expectDescriptor) {
    return undefined;
  }
  const descriptor = descriptorPayload.descriptors.find(
    (entry) => asRecord(entry).pluginId === PLUGIN_ID,
  );
  if (!descriptor) {
    throw new Error(
      `plugins.uiDescriptors did not report Kitchen Sink descriptor for ${PLUGIN_ID}: ${boundedJsonPreview(
        descriptorPayload.descriptors,
      )}`,
    );
  }
  return descriptor;
}

export function assertDiagnosticStabilityClean(payload: unknown) {
  const candidate = asRecord(payload);
  const problems = [];
  if (!payload || typeof payload !== "object") {
    throw new Error(
      `diagnostics.stability returned invalid payload: ${boundedJsonPreview(payload)}`,
    );
  }
  if (typeof candidate.dropped === "number" && candidate.dropped > 0) {
    problems.push(`dropped=${candidate.dropped}`);
  }
  const payloadLarge = asRecord(asRecord(candidate.summary).payloadLarge);
  if (payloadLarge) {
    if (typeof payloadLarge.rejected === "number" && payloadLarge.rejected > 0) {
      problems.push(`payload.large rejected=${payloadLarge.rejected}`);
    }
    if (typeof payloadLarge.truncated === "number" && payloadLarge.truncated > 0) {
      problems.push(`payload.large truncated=${payloadLarge.truncated}`);
    }
  }
  const asyncDropCount = countDiagnosticEvents(payload, "diagnostic.async_queue.dropped");
  if (asyncDropCount > 0) {
    problems.push(`async diagnostic drops=${asyncDropCount}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `diagnostics.stability reported instability: ${problems.join(", ")}\n${tailText(
        boundedJsonPreview(payload, 2),
      )}`,
    );
  }
}

function assertObjectPayload(payload: unknown, label: string): JsonRecord {
  if (!isRecord(payload)) {
    throw new Error(`${label} returned invalid payload: ${boundedJsonPreview(payload)}`);
  }
  return payload;
}

export function assertGatewayHealthPayload(payload: unknown) {
  const health = assertObjectPayload(payload, "health");
  const sessions = health.sessions;
  const problems = failedPayloadChecks([
    [health.ok === true, "ok=true"],
    [Number.isFinite(health.ts), "numeric ts"],
    [Number.isFinite(health.durationMs), "numeric durationMs"],
    [isRecord(health.channels), "channels object"],
    [Array.isArray(health.channelOrder), "channelOrder array"],
    [hasNonEmptyString(health.defaultAgentId), "defaultAgentId"],
    [Array.isArray(health.agents), "agents array"],
    [
      isRecord(sessions) &&
        hasNonEmptyString(sessions.path) &&
        Number.isFinite(sessions.count) &&
        Array.isArray(sessions.recent),
      "sessions summary",
    ],
  ]);
  if (problems.length > 0) {
    throw new Error(
      `health payload missing ${problems.join(", ")}: ${boundedJsonPreview(payload)}`,
    );
  }
}

export function assertGatewayStatusPayload(payload: unknown) {
  const status = assertObjectPayload(payload, "status");
  const { heartbeat, sessions } = status;
  const problems = failedPayloadChecks([
    [
      isRecord(heartbeat) &&
        hasNonEmptyString(heartbeat.defaultAgentId) &&
        Array.isArray(heartbeat.agents),
      "heartbeat summary",
    ],
    [Array.isArray(status.channelSummary), "channelSummary array"],
    [Array.isArray(status.queuedSystemEvents), "queuedSystemEvents array"],
    [isRecord(status.tasks), "tasks summary"],
    [isRecord(status.taskAudit), "taskAudit summary"],
    [
      isRecord(sessions) &&
        Array.isArray(sessions.paths) &&
        Number.isFinite(sessions.count) &&
        Array.isArray(sessions.recent) &&
        Array.isArray(sessions.byAgent) &&
        isRecord(sessions.defaults),
      "sessions summary",
    ],
  ]);
  if (problems.length > 0) {
    throw new Error(
      `status payload missing ${problems.join(", ")}: ${boundedJsonPreview(payload)}`,
    );
  }
}

function failedPayloadChecks(checks: Array<[boolean, string]>) {
  return checks.filter(([passed]) => !passed).map(([, label]) => label);
}

function countDiagnosticEvents(payload: unknown, type: string): number {
  const candidate = asRecord(payload);
  const summaryCount = asRecord(asRecord(candidate.summary).byType)[type];
  if (typeof summaryCount === "number" && Number.isFinite(summaryCount)) {
    return summaryCount;
  }
  return (Array.isArray(candidate.events) ? candidate.events : []).filter(
    (event) => asRecord(event).type === type,
  ).length;
}

export async function sampleProcess(
  pid: number,
  options: SampleProcessOptions = {},
): Promise<ProcessSample | null> {
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;
  if (!pid) {
    return null;
  }
  if (platform === "win32") {
    return sampleWindowsProcess(pid, run, options.windowsCommandLineNeedles);
  }
  return samplePosixProcess(pid, run, options.posixCommandLineNeedles);
}

export function summarizeProcessSamples(samples: Array<ProcessSample | null>) {
  const validSamples = samples.filter(
    (sample): sample is ProcessSample => sample !== null && Number.isFinite(sample.rssMiB),
  );
  if (validSamples.length === 0) {
    return null;
  }
  const peakRssSample = validSamples.reduce((peak, sample) =>
    (sample.aggregateRssMiB ?? sample.rssMiB) > (peak.aggregateRssMiB ?? peak.rssMiB)
      ? sample
      : peak,
  );
  const numericCpuSamples = validSamples
    .map((sample) => sample.cpuPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    ...peakRssSample,
    sampleCount: validSamples.length,
    peakCpuPercent:
      numericCpuSamples.length > 0 ? Math.max(...numericCpuSamples) : peakRssSample.cpuPercent,
  };
}

async function samplePosixProcess(
  pid: number,
  run: CommandRunner,
  commandLineNeedles: string[] = [],
) {
  const needles = commandLineNeedles
    .map((needle) => needle.trim())
    .filter((needle) => needle.length > 0);
  if (needles.length > 0) {
    return samplePosixProcessTree(pid, run, needles);
  }
  return samplePosixProcessWithDescendants(pid, run);
}

async function samplePosixProcessWithDescendants(pid: number, run: CommandRunner) {
  const snapshot = await readPosixProcessTreeSnapshot(pid, run);
  if (!snapshot) {
    return null;
  }
  return formatPosixProcessTreeSample(snapshot.rootRow, snapshot.rootTreeRows);
}

async function samplePosixProcessTree(
  pid: number,
  run: CommandRunner,
  commandLineNeedles: string[],
) {
  const snapshot = await readPosixProcessTreeSnapshot(pid, run);
  if (!snapshot) {
    return null;
  }
  const { rootRow, rootTreeRows, rows } = snapshot;
  const descendants = rootTreeRows.filter((row) => row.processId !== rootRow.processId);
  const matchesCommandNeedles = (row: PosixProcessRow) =>
    commandLineNeedles.every((needle) => row.command.toLowerCase().includes(needle.toLowerCase()));
  const commandMatches = descendants.filter(matchesCommandNeedles);
  const rootCommandMatches = matchesCommandNeedles(rootRow) ? [rootRow] : [];
  const gatewayTitleMatches = descendants.filter((row) =>
    row.command.toLowerCase().includes("openclaw-gateway"),
  );
  const selected = selectPeakRssProcess(
    commandMatches.length > 0
      ? commandMatches
      : gatewayTitleMatches.length > 0
        ? gatewayTitleMatches
        : descendants.length > 0
          ? descendants
          : rootCommandMatches,
  );
  return selected
    ? formatPosixProcessTreeSample(selected, collectPosixProcessTree(rows, selected.processId))
    : null;
}

async function readPosixProcessTreeSnapshot(pid: number, run: CommandRunner) {
  const safePid = pid;
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return null;
  }
  try {
    const { stdout } = await run("ps", POSIX_PROCESS_SNAPSHOT_ARGS, {
      timeoutMs: 5000,
    });
    const snapshot = parsePosixProcessRows(stdout);
    if (!snapshot) {
      return null;
    }
    const { malformedRows, rows } = snapshot;
    const rootTreeRows = collectPosixProcessTree(rows, safePid);
    const rootRow = rootTreeRows.find((row) => row.processId === safePid);
    if (!rootRow || hasMalformedProcessTreeRows(malformedRows, rootTreeRows)) {
      return null;
    }
    return { rootRow, rootTreeRows, rows };
  } catch {
    return null;
  }
}

function parsePosixProcessRows(stdout: string) {
  const rows: PosixProcessRow[] = [];
  const malformedRows: MalformedProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/u);
    if (!match) {
      continue;
    }
    const [, pidRaw, ppidRaw, rssKbRaw, cpuRaw, command] = match;
    if (
      !pidRaw ||
      !ppidRaw ||
      !rssKbRaw ||
      !cpuRaw ||
      (!/^\d/u.test(pidRaw) && !/^\d/u.test(ppidRaw))
    ) {
      continue;
    }
    const processId = parsePositivePosixProcessToken(pidRaw);
    const parentProcessId = parseStrictUnsignedInteger(ppidRaw);
    const rssKb = parsePositivePosixProcessToken(rssKbRaw);
    const cpuPercent = parseStrictNonNegativeDecimal(cpuRaw);
    if (
      !Number.isInteger(processId) ||
      !Number.isInteger(parentProcessId) ||
      processId === null ||
      parentProcessId === null ||
      rssKb === null
    ) {
      malformedRows.push({
        pidRaw,
        ppidRaw,
      });
      continue;
    }
    rows.push({
      processId,
      parentProcessId,
      rssKb,
      cpuPercent,
      command: command ?? "",
    });
  }
  return { malformedRows, rows };
}

function parseStrictNonNegativeDecimal(raw: string | undefined) {
  const text = (raw ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStrictUnsignedInteger(raw: string | undefined) {
  const text = (raw ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositivePosixProcessToken(raw: string | undefined) {
  const parsed = parseStrictUnsignedInteger(raw);
  return parsed && parsed > 0 ? parsed : null;
}

function parseTasklistMemoryKiB(raw: string | undefined) {
  const text = (raw ?? "").trim();
  const match = text.match(/^((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))\s*K$/iu);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]?.replaceAll(",", "") ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectPosixProcessTree(rows: PosixProcessRow[], rootPid: number) {
  const byParent = new Map<number, PosixProcessRow[]>();
  for (const row of rows) {
    const children = byParent.get(row.parentProcessId) ?? [];
    children.push(row);
    byParent.set(row.parentProcessId, children);
  }
  const root = rows.find((row) => row.processId === rootPid);
  const collected = root ? [root] : [];
  const pending = [rootPid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const nextPid = pending.shift();
    if (nextPid === undefined) {
      break;
    }
    for (const child of byParent.get(nextPid) ?? []) {
      if (seen.has(child.processId)) {
        continue;
      }
      seen.add(child.processId);
      collected.push(child);
      pending.push(child.processId);
    }
  }
  return collected;
}

function hasMalformedProcessTreeRows(
  malformedRows: MalformedProcessRow[],
  treeRows: PosixProcessRow[],
) {
  if (malformedRows.length === 0 || treeRows.length === 0) {
    return false;
  }
  const treePids = new Set(treeRows.map((row) => row.processId));
  return malformedRows.some(
    (row) =>
      rawProcessTokenMatchesTree(row.pidRaw, treePids) ||
      rawProcessTokenMatchesTree(row.ppidRaw, treePids),
  );
}

function rawProcessTokenMatchesTree(raw: string, treePids: Set<number>) {
  const text = raw.trim();
  for (const pid of treePids) {
    const pidText = String(pid);
    if (text === pidText) {
      return true;
    }
    if (text.startsWith(pidText) && !/\d/u.test(text.at(pidText.length) ?? "")) {
      return true;
    }
  }
  return false;
}

function selectPeakRssProcess(rows: PosixProcessRow[]) {
  return rows.reduce<PosixProcessRow | null>(
    (peak, row) => (peak && peak.rssKb >= row.rssKb ? peak : row),
    null,
  );
}

function formatPosixProcessSample(row: PosixProcessRow): ProcessSample {
  return {
    rssMiB: Math.round((row.rssKb / 1024) * 10) / 10,
    aggregateRssMiB: Math.round((row.rssKb / 1024) * 10) / 10,
    cpuPercent: row.cpuPercent,
    processId: row.processId,
  };
}

function formatPosixProcessTreeSample(
  selected: PosixProcessRow,
  rows: PosixProcessRow[],
): ProcessSample {
  const aggregateRssKb = rows.reduce((sum, row) => sum + row.rssKb, 0);
  return {
    ...formatPosixProcessSample(selected),
    aggregateRssMiB: Math.round((aggregateRssKb / 1024) * 10) / 10,
  };
}

function parseTasklistCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

async function sampleWindowsPidWithTasklist(pid: number, run: CommandRunner) {
  const safePid = pid;
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return null;
  }
  try {
    const { stdout } = await run(
      resolveWindowsSystem32Path("tasklist.exe"),
      ["/FI", `PID eq ${safePid}`, "/FO", "CSV", "/NH"],
      { timeoutMs: 15000 },
    );
    const line = stdout
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('"'));
    if (!line) {
      return null;
    }
    const tasklistFields = parseTasklistCsvLine(line);
    const processIdRaw = tasklistFields[1];
    const memoryRaw = tasklistFields[4];
    const processId = parseStrictUnsignedInteger(processIdRaw);
    const memoryKiB = parseTasklistMemoryKiB(memoryRaw);
    if (memoryKiB === null) {
      return null;
    }
    return {
      rssMiB: Math.round((memoryKiB / 1024) * 10) / 10,
      cpuPercent: null,
      cpuSeconds: null,
      processId: processId ?? safePid,
    };
  } catch {
    return null;
  }
}

export async function sampleWindowsProcessByPort(
  port: number,
  options: { runCommand?: CommandRunner } = {},
) {
  const safePort = port;
  if (!Number.isInteger(safePort) || safePort <= 0) {
    return null;
  }
  const run = options.runCommand ?? runCommand;
  try {
    const { stdout } = await run(resolveWindowsSystem32Path("netstat.exe"), ["-ano", "-p", "tcp"], {
      timeoutMs: 15000,
    });
    const pid = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .map((line) => parseWindowsNetstatListeningPid(line, safePort))
      .find((candidate): candidate is number => candidate !== null && candidate > 0);
    if (!pid) {
      return null;
    }
    return (await sampleWindowsProcess(pid, run)) ?? sampleWindowsPidWithTasklist(pid, run);
  } catch {
    return null;
  }
}

function parseWindowsNetstatListeningPid(line: string, port: number) {
  if (!/\bLISTENING\b/iu.test(line)) {
    return null;
  }
  const fields = line.trim().split(/\s+/u);
  const localPortMatch = fields[1]?.match(/:(\d+)$/u);
  if (!localPortMatch || Number(localPortMatch[1]) !== port) {
    return null;
  }
  const processId = Number(fields.at(-1) ?? "");
  return Number.isSafeInteger(processId) && processId > 0 ? processId : null;
}

function powershellSingleQuoted(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

async function sampleWindowsProcess(
  pid: number,
  run: CommandRunner,
  commandLineNeedles: string[] = [],
) {
  const safePid = pid;
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return null;
  }
  const needles = commandLineNeedles
    .map((needle) => needle.trim())
    .filter((needle) => needle.length > 0);
  const powershellNeedles = `@(${needles.map(powershellSingleQuoted).join(", ")})`;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$rootPid = ${safePid}`,
    `$commandLineNeedles = ${powershellNeedles}`,
    "$ids = [System.Collections.Generic.HashSet[int]]::new()",
    "[void]$ids.Add($rootPid)",
    'if ($commandLineNeedles.Count -gt 0) { $queryNeedle = $commandLineNeedles[$commandLineNeedles.Count - 1].Replace("\'", "\'\'"); $candidates = Get-CimInstance Win32_Process -Filter "CommandLine LIKE \'%$queryNeedle%\'" | Select-Object ProcessId, CommandLine; foreach ($process in $candidates) { if ([int]$process.ProcessId -eq $PID) { continue }; $line = [string]$process.CommandLine; $matches = $true; foreach ($needle in $commandLineNeedles) { if ($line.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $matches = $false; break } }; if ($matches) { [void]$ids.Add([int]$process.ProcessId) } } }',
    "$processes = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId",
    "$changed = $true",
    "$whileGuard = 0",
    "while ($changed -and $whileGuard -lt 1024) { $whileGuard += 1; $changed = $false; foreach ($process in $processes) { if ($ids.Contains([int]$process.ParentProcessId) -and -not $ids.Contains([int]$process.ProcessId)) { [void]$ids.Add([int]$process.ProcessId); $changed = $true } } }",
    "$samples = foreach ($id in $ids) { try { Get-Process -Id $id -ErrorAction Stop } catch {} }",
    "$process = $samples | Sort-Object WorkingSet64 -Descending | Select-Object -First 1",
    "if ($null -eq $process) { exit 2 }",
    "$totalWorkingSet = ($samples | Measure-Object -Property WorkingSet64 -Sum).Sum",
    "$cpu = 0",
    "if ($null -ne $process.CPU) { $cpu = $process.CPU }",
    "[Console]::Out.Write(('{0} {1} {2} {3}' -f $process.WorkingSet64, $cpu, $process.Id, $totalWorkingSet))",
  ].join("; ");
  const powershell = resolveWindowsPowerShellPath();
  try {
    const { stdout } = await run(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeoutMs: 15000 },
    );
    const [workingSetBytesRaw, cpuSecondsRaw, processIdRaw, aggregateWorkingSetBytesRaw] = stdout
      .trim()
      .split(/\s+/u);
    const workingSetBytes = parseStrictUnsignedInteger(workingSetBytesRaw);
    const aggregateWorkingSetBytes = parseStrictUnsignedInteger(
      aggregateWorkingSetBytesRaw ?? workingSetBytesRaw ?? "",
    );
    const cpuSeconds = parseStrictNonNegativeDecimal(cpuSecondsRaw);
    const processId = parseStrictUnsignedInteger(processIdRaw);
    if (workingSetBytes === null) {
      return null;
    }
    return {
      rssMiB: Math.round((workingSetBytes / 1024 / 1024) * 10) / 10,
      aggregateRssMiB:
        aggregateWorkingSetBytes !== null
          ? Math.round((aggregateWorkingSetBytes / 1024 / 1024) * 10) / 10
          : Math.round((workingSetBytes / 1024 / 1024) * 10) / 10,
      cpuPercent: null,
      cpuSeconds,
      processId: processId ?? safePid,
    };
  } catch {
    return null;
  }
}

function assertProcessResourceCeiling(
  sample: ProcessSample | null,
  options: { label: string; maxRssMiB: number; requireSample?: boolean },
) {
  const { label, maxRssMiB, requireSample = true } = options;
  if (!sample) {
    if (requireSample) {
      throw new Error(`${label} RSS sample was not captured`);
    }
    return;
  }
  if (!Number.isFinite(sample.rssMiB) || sample.rssMiB <= 0) {
    throw new Error(`${label} RSS sample was invalid: ${String(sample.rssMiB)} MiB`);
  }
  const aggregateRssMiB = sample.aggregateRssMiB ?? sample.rssMiB;
  if (!Number.isFinite(aggregateRssMiB) || aggregateRssMiB <= 0) {
    throw new Error(`${label} aggregate RSS sample was invalid: ${String(aggregateRssMiB)} MiB`);
  }
  if (sample.rssMiB > maxRssMiB) {
    throw new Error(`${label} RSS exceeded ${maxRssMiB} MiB: ${sample.rssMiB} MiB`);
  }
  if (aggregateRssMiB > maxRssMiB) {
    throw new Error(`${label} aggregate RSS exceeded ${maxRssMiB} MiB: ${aggregateRssMiB} MiB`);
  }
}

export function assertResourceCeiling(sample: ProcessSample | null) {
  const config = resolveKitchenSinkRpcConfig();
  assertProcessResourceCeiling(sample, {
    label: "gateway",
    maxRssMiB: config.maxRssMiB,
  });
}

export function assertCommandResourceCeiling(sample: ProcessSample | null) {
  const config = resolveKitchenSinkRpcConfig();
  assertProcessResourceCeiling(sample, {
    label: "command",
    maxRssMiB: config.commandMaxRssMiB,
  });
}

export function findErrorLogFindings(logPath: string): Array<{ line: string; lineNumber: number }> {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const scanBytes = fs.statSync(logPath).size;

  const findings: Array<{ line: string; lineNumber: number }> = [];
  let currentLine = "";
  let currentLineNumber = 1;
  let currentLineHasFinding = false;
  let currentLineTruncated = false;
  const recordLine = (lineNumber: number, line: string) => {
    if (currentLineHasFinding) {
      return;
    }
    if (
      ERROR_LOG_ALLOW_PATTERNS.some((pattern) => pattern.test(line)) ||
      !ERROR_LOG_DENY_PATTERNS.some((pattern) => pattern.test(line))
    ) {
      return;
    }
    currentLineHasFinding = true;
    findings.push({ line, lineNumber });
    if (findings.length > 20) {
      findings.shift();
    }
  };
  const inspectCurrentLine = () => {
    const normalizedLine = currentLine.replace(/\r$/u, "");
    const line = currentLineTruncated ? `[truncated] ${normalizedLine}` : normalizedLine;
    recordLine(currentLineNumber, line);
  };
  const appendLineFragment = (fragment: string) => {
    currentLine += fragment;
    if (currentLine.length <= LOG_SCAN_MAX_LINE_CHARS) {
      return;
    }
    inspectCurrentLine();
    currentLine = currentLine.slice(-LOG_SCAN_MAX_LINE_CHARS);
    currentLineTruncated = true;
  };
  const finishLine = () => {
    inspectCurrentLine();
    currentLine = "";
    currentLineNumber += 1;
    currentLineHasFinding = false;
    currentLineTruncated = false;
  };

  const fd = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(LOG_SCAN_CHUNK_BYTES);
    let offset = 0;
    while (offset < scanBytes) {
      const bytesToRead = Math.min(buffer.length, scanBytes - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\n/u);
      for (const [index, line] of lines.entries()) {
        appendLineFragment(line);
        if (index < lines.length - 1) {
          finishLine();
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (currentLine) {
    inspectCurrentLine();
  }
  return findings;
}

function assertNoErrorLogs(logPath: string) {
  const findings = findErrorLogFindings(logPath);
  if (findings.length > 0) {
    throw new Error(
      `unexpected error-like gateway logs:\n${findings
        .map(({ line, lineNumber }) => `${logPath}:${lineNumber}: ${line}`)
        .join("\n")}`,
    );
  }
}

function tailFile(file: string, maxBytes = LOG_TAIL_BYTES) {
  return tailText(readTextFileTail(file, Math.max(1, maxBytes)));
}

function tailText(text: string) {
  return text.split(/\r?\n/u).slice(-120).join("\n");
}

async function main() {
  const config = resolveKitchenSinkRpcConfig();
  let runner = resolveOpenClawRunner();
  const port = await resolveKitchenSinkRpcPort();
  const { root, env } = makeEnv();
  const logPath = path.join(root, "gateway.log");
  const keepTmp = process.env.OPENCLAW_KITCHEN_SINK_KEEP_TMP === "1";
  let failed = false;
  let child: GatewayChild | undefined;

  const processSamples: ProcessSample[] = [];
  const commandSamples: TimedProcessSample[] = [];
  const commandResourceOptions: Pick<
    RunCommandOptions,
    "resourceSampleIntervalMs" | "resourceSamples"
  > = {
    resourceSampleIntervalMs: 500,
    resourceSamples: commandSamples,
  };
  let sampleInFlight: Promise<ProcessSample | null> | null = null;
  let sampleTimer: ReturnType<typeof setInterval> | undefined;
  try {
    console.log(`Kitchen Sink RPC walk using ${PLUGIN_SPEC} via ${runner.label}`);
    const installHelp = await runOpenClaw(runner, ["plugins", "install", "--help"], env);
    if (installHelp.stdoutTruncatedChars > 0) {
      throw new Error("Plugin fixture help probe output was truncated");
    }
    await runOpenClaw(
      runner,
      [
        "plugins",
        "install",
        PLUGIN_SPEC,
        "--force",
        ...fixtureCapabilityConsentArgs(installHelp.stdout),
      ],
      env,
      {
        ...commandResourceOptions,
        requireResourceSample: true,
        resourceLabel: "plugins install",
        timeoutMs: config.installTimeoutMs,
      },
    );
    runner = resolveOpenClawRunner();
    console.log(`Kitchen Sink RPC runtime runner: ${runner.label}`);
    configureKitchenSink(env, port);
    await runOpenClaw(runner, ["plugins", "enable", PLUGIN_ID], env, {
      ...commandResourceOptions,
      resourceLabel: "plugins enable",
      timeoutMs: 60000,
    });
    const inspect = parseJsonOutput(
      (
        await runOpenClaw(runner, ["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"], env, {
          ...commandResourceOptions,
          resourceLabel: "plugins inspect",
        })
      ).stdout,
    );
    const inspectPlugin = asRecord(inspect.plugin);
    if (inspectPlugin.status !== "loaded") {
      throw new Error(
        `Kitchen Sink plugin did not inspect as loaded: ${boundedJsonPreview(inspect)}`,
      );
    }
    const inspectProviders = [
      ...(Array.isArray(inspectPlugin.providerIds) ? inspectPlugin.providerIds : []),
      ...(Array.isArray(inspectPlugin.providers) ? inspectPlugin.providers : []),
    ];
    assertIncludesAny(inspectProviders, EXPECTED_PROVIDERS, "plugins inspect providers");

    child = await startGateway(runner, port, env, logPath);
    const gatewayChild = child;
    const rpcOptions: RpcCallOptions = { commandResourceOptions, env, port, runner };
    const sampleGateway = async () => {
      const gatewayCommandLineNeedles = ["gateway", "--port", String(port)];
      const processSampleOptions = runner.pnpm
        ? {
            posixCommandLineNeedles: gatewayCommandLineNeedles,
            windowsCommandLineNeedles: gatewayCommandLineNeedles,
          }
        : {};
      let sample = gatewayChild.pid
        ? await sampleProcess(gatewayChild.pid, processSampleOptions)
        : null;
      if (!sample && process.platform === "win32") {
        sample = await sampleWindowsProcessByPort(port);
      }
      if (sample) {
        processSamples.push(sample);
      }
      return sample;
    };
    const collectTimedSample = () => {
      sampleInFlight ??= sampleGateway().finally(() => {
        sampleInFlight = null;
      });
      return sampleInFlight;
    };

    await waitForGatewayReady(gatewayChild, port, logPath);
    const initialSample = await sampleGateway();
    sampleTimer = setInterval(() => {
      void collectTimedSample().catch(() => {});
    }, 1000);
    sampleTimer.unref?.();
    const healthz = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    const readyz = await fetchJson(`http://127.0.0.1:${port}/readyz`);
    if (!healthz.ok || asRecord(healthz.body).status !== "live") {
      throw new Error(`/healthz did not report live: ${boundedJsonPreview(healthz)}`);
    }
    if (!readyz.ok || asRecord(readyz.body).ready !== true) {
      throw new Error(`/readyz did not report ready: ${boundedJsonPreview(readyz)}`);
    }

    const health = await retryRpcCall("health", {}, rpcOptions);
    assertGatewayHealthPayload(health);
    const status = await retryRpcCall("status", {}, rpcOptions);
    assertGatewayStatusPayload(status);
    const channelStatus = await retryRpcCall(
      "channels.status",
      { probe: true, timeoutMs: 10000 },
      rpcOptions,
    );
    const channelAccount = assertChannelAccountRunning(channelStatus);

    const commands = await retryRpcCall(
      "commands.list",
      { agentId: "main", scope: "text" },
      rpcOptions,
    );
    const commandNames = extractPluginCommandNames(commands);
    assertIncludesAll(commandNames, EXPECTED_COMMANDS, "commands.list plugin commands");

    const catalog = await retryRpcCall(
      "tools.catalog",
      { agentId: "main", includePlugins: true },
      rpcOptions,
    );
    const catalogTools = extractToolEntries(catalog);
    const catalogToolIds = assertExpectedKitchenSinkToolEntries(
      catalogTools,
      "tools.catalog plugin tools",
      { requirePluginProvenance: true },
    );

    const createdSession = assertCreatedKitchenSinkSession(
      await retryRpcCall(
        "sessions.create",
        { key: SESSION_KEY, agentId: "main", label: "kitchen-sink-rpc" },
        rpcOptions,
      ),
    );
    const effective = await retryRpcCall(
      "tools.effective",
      { sessionKey: String(createdSession.key), agentId: "main" },
      rpcOptions,
    );
    assertExpectedKitchenSinkToolEntries(
      extractToolEntries(effective),
      "tools.effective plugin tools",
      { requirePluginProvenance: true },
    );

    for (const toolInvoke of KITCHEN_SINK_TOOL_INVOKES) {
      const invoked = await retryRpcCall(
        "tools.invoke",
        {
          name: toolInvoke.name,
          args: toolInvoke.args,
          sessionKey: String(createdSession.key),
          agentId: "main",
          idempotencyKey: toolInvoke.idempotencyKey,
        },
        rpcOptions,
      );
      toolInvoke.assertResult(invoked);
    }

    const readOnlyRpcSurfaces = [];
    for (const probe of READ_ONLY_RPC_PROBES) {
      await retryRpcCall(probe.method, probe.params, rpcOptions);
      readOnlyRpcSurfaces.push(probe.method);
    }
    await retryRpcCall("artifacts.list", { sessionKey: String(createdSession.key) }, rpcOptions);
    readOnlyRpcSurfaces.push("artifacts.list");
    const authorizationBoundaries = [];
    for (const probe of AUTHORIZATION_RPC_PROBES) {
      await assertOperatorRpcDenied(probe, (method, params) =>
        retryRpcCall(method, params, rpcOptions),
      );
      authorizationBoundaries.push(probe.method);
    }

    const ttsProviders = await retryRpcCall("tts.providers", {}, rpcOptions);
    const ttsStatus = await retryRpcCall("tts.status", {}, rpcOptions);
    assertTtsProviderCoverage(ttsProviders, "providers");
    assertTtsProviderCoverage(ttsStatus, "status");

    const uiDescriptors = await retryRpcCall("plugins.uiDescriptors", {}, rpcOptions);
    assertKitchenSinkUiDescriptors(uiDescriptors, {
      expectDescriptor: env.OPENCLAW_KITCHEN_SINK_PERSONALITY !== "conformance",
    });
    const stability = await retryRpcCall("diagnostics.stability", {}, rpcOptions);
    assertDiagnosticStabilityClean(stability);
    await settlePendingSample(sampleInFlight);
    const finalSample = await sampleGateway();
    assertResourceCeiling(finalSample);
    const peakSample = summarizeProcessSamples(processSamples);
    const commandPeakSample = summarizeProcessSamples(commandSamples);
    assertResourceCeiling(peakSample);
    assertCommandResourceCeiling(commandPeakSample);
    assertNoErrorLogs(logPath);

    console.log(
      JSON.stringify(
        {
          ok: true,
          pluginId: PLUGIN_ID,
          commands: commandNames,
          catalogTools: catalogToolIds.filter((id) => EXPECTED_TOOLS.includes(id)),
          readOnlyRpcSurfaces,
          authorizationBoundaries,
          channelAccount,
          commandPeakSample,
          initialSample,
          finalSample,
          peakSample,
        },
        null,
        2,
      ),
    );
    console.log("Kitchen Sink RPC walk passed");
  } catch (error) {
    failed = true;
    console.error(tailFile(logPath));
    throw error;
  } finally {
    if (sampleTimer) {
      clearInterval(sampleTimer);
    }
    if (child) {
      await stopGateway(child);
    }
    if (!failed && !keepTmp) {
      await cleanupKitchenSinkEnv(root, { throwOnFailure: true });
    } else if (failed || keepTmp) {
      console.error(`Kitchen Sink RPC temp root preserved: ${root}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (shouldPrintHelp(argv)) {
    process.stdout.write(usage());
  } else {
    try {
      validateCliArgs(argv);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    await main();
  }
}

function errorCode(value: unknown) {
  return asRecord(value).code;
}

function isCallGatewayModule(
  value: unknown,
): value is { callGateway: (options: JsonRecord) => Promise<unknown> } {
  return isRecord(value) && typeof value.callGateway === "function";
}

function isGatewayChild(value: unknown): value is GatewayChild {
  return typeof asRecord(value).kill === "function";
}

async function settlePendingSample(pending: Promise<unknown> | null) {
  await pending?.catch(() => {});
}
