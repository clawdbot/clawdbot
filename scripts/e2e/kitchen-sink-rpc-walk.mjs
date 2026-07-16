// Walks the kitchen-sink gateway RPC scenario for E2E smoke coverage.
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveWindowsPowerShellPath,
  resolveWindowsSystem32Path,
  resolveWindowsTaskkillPath,
} from "../lib/windows-taskkill.mjs";

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

let callGatewayModulePromise;
const activeCommandChildren = new Set();
const commandParentSignals =
  process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
let commandShutdownPromise;
let commandSignalHandlersInstalled = false;

function installCommandSignalHandlers() {
  if (commandSignalHandlersInstalled) {
    return;
  }
  commandSignalHandlersInstalled = true;
  for (const signal of commandParentSignals) {
    process.on(signal, commandSignalHandlers.get(signal));
  }
}

function removeCommandSignalHandlers() {
  if (!commandSignalHandlersInstalled) {
    return;
  }
  commandSignalHandlersInstalled = false;
  for (const signal of commandParentSignals) {
    process.off(signal, commandSignalHandlers.get(signal));
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
  return `Usage: node scripts/e2e/kitchen-sink-rpc-walk.mjs

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

export function shouldPrintHelp(argv) {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

export function validateCliArgs(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

export function readPositiveInt(raw, fallback, label = "value") {
  const text = String(raw || "").trim();
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

function clampKitchenSinkTimerTimeoutMs(value) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
}

export function readPositiveTimerMs(raw, fallback, label = "value") {
  return clampKitchenSinkTimerTimeoutMs(readPositiveInt(raw, fallback, label));
}

export function resolveKitchenSinkRpcConfig(env = process.env) {
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

async function findAvailableLoopbackPort(options = {}) {
  const createServer = options.createServer ?? (() => net.createServer());
  const server = createServer();
  return await new Promise((resolve, reject) => {
    const fail = (error) => {
      server.close?.(() => {});
      reject(toLintErrorObject(error, "Unable to reserve Kitchen Sink RPC loopback port"));
    };
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off?.("error", fail);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(toLintErrorObject(error, "Unable to close Kitchen Sink RPC loopback port"));
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

export async function resolveKitchenSinkRpcPort(env = process.env, options = {}) {
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

function resolveOpenClawRunner() {
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

export async function cleanupKitchenSinkEnv(root, options = {}) {
  if (root) {
    const attempts = Math.max(1, options.attempts ?? 5);
    const delayMs = Math.max(0, options.delayMs ?? 250);
    let lastError;
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function appendBoundedOutput(
  buffer,
  chunk,
  maxChars = resolveKitchenSinkRpcConfig().outputCaptureChars,
) {
  const text = String(chunk);
  const combined = `${buffer.text}${text}`;
  const overflowChars = Math.max(0, combined.length - maxChars);
  return {
    text: overflowChars > 0 ? combined.slice(overflowChars) : combined,
    truncatedChars: buffer.truncatedChars + overflowChars,
  };
}

function formatCapturedOutput(label, buffer) {
  return buffer.truncatedChars > 0
    ? `[${label} truncated ${buffer.truncatedChars} chars]\n${buffer.text}`
    : buffer.text;
}

export function runCommand(command, args, options = {}) {
  if (commandShutdownPromise) {
    return commandShutdownPromise.then(() => {
      throw new Error(`${command} ${args.join(" ")} skipped during parent signal shutdown`);
    });
  }
  return new Promise((resolve, reject) => {
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
    let forceKillTimer;
    let forceKillAt;
    let sampleTimer;
    let resourceSampleInFlight = null;
    let capturedResourceSampleCount = 0;
    let lastResourceSampleError = null;
    const commandLabel = resourceLabel ?? [command, ...args.slice(0, 2)].join(" ");
    const shouldSampleResources = Array.isArray(resourceSamples);
    const collectResourceSample = () => {
      if (!shouldSampleResources || !child.pid) {
        return null;
      }
      resourceSampleInFlight ??= Promise.resolve()
        .then(() => sampleProcessImpl(child.pid, resourceSampleOptions ?? {}))
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
        .catch((/** @type {unknown} */ error) => {
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
      stdout = appendBoundedOutput(stdout, chunk, outputCaptureChars);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk, outputCaptureChars);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      forceKillAt = undefined;
      releaseCommandChild(child);
      void stopResourceSampling().finally(() =>
        reject(toLintErrorObject(error, "Command failed before exit")),
      );
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

async function finishTimedOutCommandProcessTree(child, { forceKillAt, timeoutKillGraceMs }) {
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

function releaseCommandChild(child) {
  activeCommandChildren.delete(child);
  if (activeCommandChildren.size === 0 && !commandShutdownPromise) {
    removeCommandSignalHandlers();
  }
}

async function shutdownActiveCommands(signal) {
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

function resolveCommandParentSignalKillGraceMs(env) {
  const raw = env.VITEST && env.OPENCLAW_TEST_KITCHEN_SINK_PARENT_SIGNAL_KILL_GRACE_MS;
  if (!raw) {
    return COMMAND_PARENT_SIGNAL_KILL_GRACE_MS;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : COMMAND_PARENT_SIGNAL_KILL_GRACE_MS;
}

async function waitForCommandProcessTreeExit(child, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!commandProcessTreeIsAlive(child)) {
      return true;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, COMMAND_PROCESS_TREE_EXIT_POLL_MS);
    });
  }
  return !commandProcessTreeIsAlive(child);
}

function commandProcessTreeIsAlive(child) {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return !hasChildExited(child);
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function signalWindowsProcessTree(pid, signal, runTaskkill = childProcess.spawnSync) {
  const taskkillPath = resolveWindowsTaskkillPath();
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
  return !result?.error && result?.status === 0;
}

function signalWindowsProcessTreeOrForce(pid, signal, runTaskkill = childProcess.spawnSync) {
  if (signalWindowsProcessTree(pid, signal, runTaskkill)) {
    return true;
  }
  return signal !== "SIGKILL" && signalWindowsProcessTree(pid, "SIGKILL", runTaskkill);
}

export function signalProcessGroup(
  child,
  signal,
  {
    platform = process.platform,
    runTaskkill = childProcess.spawnSync,
    useProcessGroup = platform !== "win32",
  } = {},
) {
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  if (platform === "win32" && typeof child.pid === "number") {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

async function runOpenClaw(runner, args, env, options = {}) {
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

async function resolveOpenClawCommand(runner, args, env, options = {}) {
  if (runner.pnpm) {
    const { createPnpmRunnerSpawnSpec } = await import("../pnpm-runner.mjs");
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

export function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("command produced no JSON output");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const candidate of extractBalancedJsonObjects(trimmed).toReversed()) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Continue looking for the final complete JSON object.
      }
    }
  }
  throw new Error(`JSON output was not parseable:\n${tailText(trimmed)}`);
}

export function parseGatewayCliRequestFailure(error) {
  if (typeof error?.stdout !== "string" || !error.stdout.trim()) {
    return null;
  }
  let payload;
  try {
    payload = parseJsonOutput(error.stdout);
  } catch {
    return null;
  }
  return payload?.ok === false ? createGatewayClientRequestError(payload.error) : null;
}

function createGatewayClientRequestError(requestError) {
  if (
    requestError?.type !== "gateway_request_error" ||
    !isNonEmptyString(requestError.code) ||
    !isNonEmptyString(requestError.message) ||
    typeof requestError.retryable !== "boolean" ||
    (requestError.retryAfterMs !== undefined &&
      (typeof requestError.retryAfterMs !== "number" ||
        !Number.isInteger(requestError.retryAfterMs) ||
        requestError.retryAfterMs < 0))
  ) {
    return null;
  }
  return Object.assign(new Error(requestError.message), {
    name: "GatewayClientRequestError",
    gatewayCode: requestError.code,
    ...(requestError.details !== undefined ? { details: requestError.details } : {}),
    retryable: requestError.retryable,
    ...(requestError.retryAfterMs !== undefined ? { retryAfterMs: requestError.retryAfterMs } : {}),
  });
}

function boundedJsonPreview(value, space) {
  try {
    return JSON.stringify(previewJsonValue(value), null, space) ?? String(value);
  } catch (error) {
    return `[unserializable: ${error?.message ?? String(error)}]`;
  }
}

function previewJsonValue(value, depth = 0, seen = new WeakSet()) {
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
  if (typeof value !== "object") {
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

    const preview = {};
    let included = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (included >= JSON_PREVIEW_OBJECT_KEYS) {
        preview.truncatedKeys = "more keys omitted";
        break;
      }
      preview[key] = previewJsonValue(value[key], depth + 1, seen);
      included += 1;
    }
    return preview;
  } finally {
    seen.delete(value);
  }
}

function previewJsonString(value) {
  const limit = JSON_PREVIEW_STRING_HEAD_CHARS + JSON_PREVIEW_STRING_TAIL_CHARS;
  if (value.length <= limit) {
    return value;
  }
  const omitted = value.length - limit;
  return `${value.slice(0, JSON_PREVIEW_STRING_HEAD_CHARS)}... [truncated ${omitted} chars] ...${value.slice(
    -JSON_PREVIEW_STRING_TAIL_CHARS,
  )}`;
}

function extractBalancedJsonObjects(text) {
  const candidates = [];
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

function isJsonObjectRecordStart(text, index) {
  if (index === 0) {
    return true;
  }
  let cursor = index - 1;
  while (cursor >= 0 && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor -= 1;
  }
  return cursor < 0 || text[cursor] === "\n" || text[cursor] === "\r";
}

function findBalancedJsonObjectEnd(text, startIndex) {
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

function hasOwnPayloadField(raw, field) {
  return (
    ((typeof raw === "object" && raw !== null) || typeof raw === "function") &&
    Object.hasOwn(raw, field)
  );
}

export function unwrapRpcPayload(raw) {
  if (raw?.ok === false) {
    const requestError = createGatewayClientRequestError(raw.error);
    if (requestError) {
      throw requestError;
    }
    throw new Error(`gateway RPC failed: ${boundedJsonPreview(raw.error ?? raw)}`);
  }
  if (
    hasOwnPayloadField(raw, "error") &&
    !hasOwnPayloadField(raw, "result") &&
    !hasOwnPayloadField(raw, "payload") &&
    !hasOwnPayloadField(raw, "data")
  ) {
    throw new Error(`gateway RPC returned error envelope: ${boundedJsonPreview(raw.error)}`);
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

async function rpcCall(method, params, options) {
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

async function loadCallGatewayModule(runner) {
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
    const module = await import(pathToFileURL(path.join(distDir, name)).href);
    if (typeof module.callGateway === "function") {
      return module;
    }
  }
  throw new Error(`unable to find callGateway export in dist (${candidates.join(", ")})`);
}

async function rpcCallViaCli(method, params, options) {
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

export function createRpcCliRunOptions(method, options = {}) {
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
        .filter((name) => /^call(?:\.runtime)?-[A-Za-z0-9_-]+\.js$/u.test(name))
        .toSorted((left, right) => left.localeCompare(right))
    : [];
}

export function usesBuiltOpenClawEntry(runner, cwd = process.cwd(), env = process.env) {
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

async function retryRpcCall(method, params, options) {
  const started = Date.now();
  const config = resolveKitchenSinkRpcConfig(options.env);
  let lastError;
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
  throw toLintErrorObject(
    lastError ?? new Error(`gateway RPC ${method} timed out before retry`),
    "Non-Error thrown",
  );
}

function isRetryableGatewayCallError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    isRetryableTransientNetworkError(error) ||
    text.includes("gateway starting") ||
    text.includes("gateway closed") ||
    text.includes("handshake timeout") ||
    text.includes("GatewayTransportError")
  );
}

function isRetryableTransientNetworkError(error, seen = new Set()) {
  if (!error || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error;
  const message = candidate instanceof Error ? candidate.message : String(candidate);
  const code = typeof candidate === "object" && candidate !== null ? candidate.code : undefined;
  const text = `${String(code ?? "")} ${message}`;
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

export async function fetchJson(url, options = {}) {
  const config = resolveKitchenSinkRpcConfig();
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = clampKitchenSinkTimerTimeoutMs(options.timeoutMs ?? config.fetchTimeoutMs);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? config.fetchBodyMaxBytes);
  const externalSignal = options.signal;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error(`fetch ${url} timed out after ${timeoutMs}ms`), {
      code: "ETIMEDOUT",
    });
    let timeout;
    let removeExternalAbort = () => {};
    const abortPromise = externalSignal
      ? new Promise((_, reject) => {
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
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
      timeout.unref?.();
    });
    try {
      const response = await Promise.race([
        (options.fetchImpl ?? fetch)(url, { signal: controller.signal }),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      const bodyAbortPromise = abortPromise
        ? Promise.race([timeoutPromise, abortPromise])
        : timeoutPromise;
      const text = await Promise.race([
        readBoundedResponseText(response, maxBodyBytes, bodyAbortPromise),
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
  throw toLintErrorObject(lastError ?? new Error(`fetch ${url} failed`), "Non-Error thrown");
}

function getExternalAbortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("fetch aborted");
}

function createExternalAbortError(signal) {
  const reason = getExternalAbortReason(signal);
  return new Error(reason.message, { cause: reason });
}

async function delayWithAbort(delayMs, signal) {
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

export async function readBoundedResponseText(response, byteLimit, timeoutPromise) {
  const resolvedByteLimit = byteLimit ?? resolveKitchenSinkRpcConfig().fetchBodyMaxBytes;
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const parsedContentLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedContentLength) || parsedContentLength > resolvedByteLimit) {
      await response.body?.cancel?.().catch(() => undefined);
      throw createFetchBodyTooLargeError(resolvedByteLimit);
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await withOptionalTimeout(response.text(), timeoutPromise);
    if (Buffer.byteLength(text, "utf8") > resolvedByteLimit) {
      throw createFetchBodyTooLargeError(resolvedByteLimit);
    }
    return text;
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const read = reader.read();
      const { done, value } = await withOptionalTimeout(
        read,
        timeoutPromise?.catch((error) => {
          cancelReaderSoon(reader);
          throw error;
        }),
      );
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > resolvedByteLimit) {
        await reader.cancel().catch(() => undefined);
        throw createFetchBodyTooLargeError(resolvedByteLimit);
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function createFetchBodyTooLargeError(byteLimit) {
  return Object.assign(new Error(`fetch response body exceeded ${byteLimit} bytes`), {
    code: "ETOOBIG",
  });
}

async function withOptionalTimeout(promise, timeoutPromise) {
  if (!timeoutPromise) {
    return await promise;
  }
  return await Promise.race([promise, timeoutPromise]);
}

function cancelReaderSoon(reader) {
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
}

function configureKitchenSink(env, port) {
  const configPath = env.OPENCLAW_CONFIG_PATH;
  const config = fs.existsSync(configPath) ? readJson(configPath) : {};
  config.gateway = {
    ...config.gateway,
    port,
    bind: "loopback",
    auth: { mode: "token", token: TOKEN },
    controlUi: {
      ...config.gateway?.controlUi,
      enabled: false,
    },
  };
  config.plugins = {
    ...config.plugins,
    enabled: true,
    allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
    entries: {
      ...config.plugins?.entries,
      [PLUGIN_ID]: {
        ...config.plugins?.entries?.[PLUGIN_ID],
        enabled: true,
        config: {
          ...config.plugins?.entries?.[PLUGIN_ID]?.config,
          personality: env.OPENCLAW_KITCHEN_SINK_PERSONALITY,
        },
        hooks: {
          ...config.plugins?.entries?.[PLUGIN_ID]?.hooks,
          allowConversationAccess: true,
        },
      },
    },
  };
  config.channels = {
    ...config.channels,
    [CHANNEL_ID]: { enabled: true, token: "kitchen-sink-rpc" },
  };
  config.tools = {
    ...config.tools,
    profile: config.tools?.profile ?? "full",
    alsoAllow: [...new Set([...(config.tools?.alsoAllow ?? []), ...EXPECTED_TOOLS])],
  };
  config.messages = {
    ...config.messages,
    tts: {
      ...config.messages?.tts,
      provider: config.messages?.tts?.provider ?? EXPECTED_SPEECH_PROVIDERS[0],
      providers: {
        ...config.messages?.tts?.providers,
        [EXPECTED_SPEECH_PROVIDERS[0]]: {
          ...config.messages?.tts?.providers?.[EXPECTED_SPEECH_PROVIDERS[0]],
        },
      },
    },
  };
  writeJson(configPath, config);
}

async function startGateway(runner, port, env, logPath) {
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

export async function stopGateway(child, options = {}) {
  const killProcess = options.killProcess ?? defaultKillProcess;
  if (!child || !isGatewayAlive(child, killProcess)) {
    return;
  }
  const teardownGraceMs = Math.max(0, options.teardownGraceMs ?? GATEWAY_TEARDOWN_GRACE_MS);
  const killGraceMs = Math.max(0, options.killGraceMs ?? GATEWAY_TEARDOWN_KILL_GRACE_MS);
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  const waitForExit = async (ms) => {
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

export function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function defaultKillProcess(pid, signal) {
  return process.kill(pid, signal);
}

function isGatewayAlive(child, killProcess) {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  }
  return !hasChildExited(child);
}

function createChildExitPromise(child) {
  if (!child || typeof child.once !== "function") {
    return null;
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function releaseUnsettledGatewayChild(child) {
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
}

export function signalGateway(child, signal, killProcess = defaultKillProcess, options = {}) {
  const {
    platform = process.platform,
    runTaskkill = childProcess.spawnSync,
    useProcessGroup = platform !== "win32",
  } = options;
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
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
    if (error?.code !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

export function createGatewayReadyLogScanner(logPath, marker = "[gateway] ready") {
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

export async function waitForGatewayReady(child, port, logPath, options = {}) {
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
        return { kind: "readyz", readyz };
      } catch (error) {
        return { kind: "error", error };
      }
    })();
    const outcome = await Promise.race([
      readyzProbe,
      ...(childExit ? [childExit.then(() => ({ kind: "child-exit" }))] : []),
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
      if (readyz.ok && readyz.body?.ready === true) {
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

export function extractPluginCommandNames(payload) {
  const commands = Array.isArray(payload?.commands) ? payload.commands : [];
  const names = [];
  for (const entry of commands) {
    if (entry?.source !== "plugin") {
      continue;
    }
    names.push(entry?.name, entry?.nativeName);
    if (Array.isArray(entry?.textAliases)) {
      names.push(...entry.textAliases);
    }
  }
  return names
    .filter(isNonEmptyString)
    .map((name) => name.replace(/^\//u, ""))
    .filter((name, index, all) => all.indexOf(name) === index)
    .toSorted((left, right) => left.localeCompare(right));
}

function extractToolEntries(payload) {
  return (Array.isArray(payload?.groups) ? payload.groups : []).flatMap((group) =>
    Array.isArray(group?.tools) ? group.tools : [],
  );
}

function assertIncludesAny(actual, expected, label) {
  if (!expected.some((value) => actual.includes(value))) {
    throw new Error(
      `${label} missing one of ${expected.join(", ")}: ${boundedJsonPreview(actual)}`,
    );
  }
}

function assertIncludesAll(actual, expected, label) {
  const missing = expected.filter((value) => !actual.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} missing ${missing.join(", ")}: ${boundedJsonPreview(actual)}`);
  }
}

export function assertExpectedKitchenSinkToolEntries(
  entries,
  label,
  { requirePluginProvenance = false } = {},
) {
  const ids = entries.map((entry) => entry?.id).filter(isNonEmptyString);
  assertIncludesAll(ids, EXPECTED_TOOLS, label);
  if (requirePluginProvenance) {
    const wrongProvenance = entries
      .filter((entry) => EXPECTED_TOOLS.includes(entry?.id))
      .filter((entry) => entry.source !== "plugin" || entry.pluginId !== PLUGIN_ID)
      .map((entry) => ({
        id: entry?.id,
        pluginId: entry?.pluginId,
        source: entry?.source,
      }));
    if (wrongProvenance.length > 0) {
      throw new Error(
        `${label} plugin provenance mismatch: ${boundedJsonPreview(wrongProvenance)}`,
      );
    }
  }
  return ids;
}

export function assertChannelAccountRunning(payload) {
  const accounts = Array.isArray(payload?.channelAccounts?.[CHANNEL_ID])
    ? payload.channelAccounts[CHANNEL_ID]
    : [];
  const account = accounts.find((entry) => entry?.accountId === CHANNEL_ACCOUNT_ID);
  if (!account) {
    const accountIds = accounts.map((entry) => entry?.accountId).filter(isNonEmptyString);
    throw new Error(
      `Kitchen Sink channel account ${CHANNEL_ACCOUNT_ID} was not reported. Available account ids: ${boundedJsonPreview(
        accountIds,
      )}`,
    );
  }
  if (!account?.running || !account?.configured) {
    throw new Error(
      `Kitchen Sink channel is not running+configured: ${boundedJsonPreview(payload)}`,
    );
  }
  return account;
}

export function extractTtsProviderIds(payload, surface) {
  const entries =
    surface === "providers"
      ? payload?.providers
      : surface === "status"
        ? payload?.providerStates
        : null;
  return (Array.isArray(entries) ? entries : []).map((entry) => entry?.id).filter(isNonEmptyString);
}

export function assertTtsProviderCoverage(payload, surface) {
  const entries =
    surface === "providers"
      ? payload?.providers
      : surface === "status"
        ? payload?.providerStates
        : null;
  if (!Array.isArray(entries)) {
    throw new Error(
      `tts.${surface} returned invalid provider list: ${boundedJsonPreview(payload)}`,
    );
  }
  const ids = extractTtsProviderIds(payload, surface);
  assertIncludesAny(ids, EXPECTED_SPEECH_PROVIDERS, `tts.${surface}`);
  const configuredEntry = entries.find(
    (entry) => EXPECTED_SPEECH_PROVIDERS.includes(entry?.id) && entry.configured === true,
  );
  if (!configuredEntry) {
    throw new Error(
      `tts.${surface} did not report a configured Kitchen Sink speech provider: ${boundedJsonPreview(
        entries,
      )}`,
    );
  }
}

export function assertKitchenSinkSearchInvokeResult(payload) {
  if (payload?.ok !== true || payload?.source !== "plugin") {
    throw new Error(`Kitchen Sink search tool invoke failed: ${boundedJsonPreview(payload)}`);
  }
  const output = assertObjectPayload(payload.output, "Kitchen Sink search tool output");
  const results = Array.isArray(output.results) ? output.results : [];
  const hasFixture = results.some((entry) => entry?.title === "Kitchen Sink image fixture");
  if (!hasFixture) {
    throw new Error(
      `Kitchen Sink search tool output missed expected fixture: ${boundedJsonPreview(output)}`,
    );
  }
}

export function assertKitchenSinkTextInvokeResult(payload) {
  if (payload?.ok !== true || payload?.source !== "plugin") {
    throw new Error(`Kitchen Sink text tool invoke failed: ${boundedJsonPreview(payload)}`);
  }
  const output = assertObjectPayload(payload.output, "Kitchen Sink text tool output");
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

export function assertKitchenSinkImageJobInvokeResult(payload) {
  if (payload?.ok !== true || payload?.source !== "plugin") {
    throw new Error(`Kitchen Sink image job tool invoke failed: ${boundedJsonPreview(payload)}`);
  }
  const output = assertObjectPayload(payload.output, "Kitchen Sink image job tool output");
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
    output.job?.status !== "completed" ||
    output.job?.route !== "tool:kitchen_sink_image_job" ||
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

function decodePngDataUrl(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match || match[1].length === 0 || match[1].length % 4 !== 0) {
    return undefined;
  }
  return Buffer.from(match[1], "base64");
}

function hasPngSignature(buffer) {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
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

export async function assertOperatorRpcDenied(probe, call) {
  try {
    await call(probe.method, probe.params);
  } catch (error) {
    const gatewayCode = error?.gatewayCode;
    const message = String(error?.message ?? "");
    if (gatewayCode === "INVALID_REQUEST" && message.includes("unauthorized role: operator")) {
      return;
    }
    throw error;
  }
  throw new Error(`${probe.method} unexpectedly allowed operator access`);
}

export function assertCreatedKitchenSinkSession(payload, expectedKey = SESSION_KEY) {
  const created = assertObjectPayload(payload, "sessions.create");
  if (created.ok !== true || created.key !== expectedKey || !isNonEmptyString(created.sessionId)) {
    throw new Error(
      `sessions.create did not return the requested Kitchen Sink session: ${boundedJsonPreview(
        payload,
      )}`,
    );
  }
  return created;
}

export function assertKitchenSinkUiDescriptors(payload, options = {}) {
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
  const descriptor = descriptorPayload.descriptors.find((entry) => entry?.pluginId === PLUGIN_ID);
  if (!descriptor) {
    throw new Error(
      `plugins.uiDescriptors did not report Kitchen Sink descriptor for ${PLUGIN_ID}: ${boundedJsonPreview(
        descriptorPayload.descriptors,
      )}`,
    );
  }
  return descriptor;
}

export function assertDiagnosticStabilityClean(payload) {
  const problems = [];
  if (!payload || typeof payload !== "object") {
    throw new Error(
      `diagnostics.stability returned invalid payload: ${boundedJsonPreview(payload)}`,
    );
  }
  if ((payload.dropped ?? 0) > 0) {
    problems.push(`dropped=${payload.dropped}`);
  }
  const payloadLarge = payload.summary?.payloadLarge;
  if (payloadLarge) {
    if ((payloadLarge.rejected ?? 0) > 0) {
      problems.push(`payload.large rejected=${payloadLarge.rejected}`);
    }
    if ((payloadLarge.truncated ?? 0) > 0) {
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

function assertObjectPayload(payload, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${label} returned invalid payload: ${boundedJsonPreview(payload)}`);
  }
  return payload;
}

export function assertGatewayHealthPayload(payload) {
  const health = assertObjectPayload(payload, "health");
  const problems = [];
  if (health.ok !== true) {
    problems.push("ok=true");
  }
  if (!Number.isFinite(health.ts)) {
    problems.push("numeric ts");
  }
  if (!Number.isFinite(health.durationMs)) {
    problems.push("numeric durationMs");
  }
  if (!health.channels || typeof health.channels !== "object" || Array.isArray(health.channels)) {
    problems.push("channels object");
  }
  if (!Array.isArray(health.channelOrder)) {
    problems.push("channelOrder array");
  }
  if (!isNonEmptyString(health.defaultAgentId)) {
    problems.push("defaultAgentId");
  }
  if (!Array.isArray(health.agents)) {
    problems.push("agents array");
  }
  if (
    !health.sessions ||
    typeof health.sessions !== "object" ||
    Array.isArray(health.sessions) ||
    !isNonEmptyString(health.sessions.path) ||
    !Number.isFinite(health.sessions.count) ||
    !Array.isArray(health.sessions.recent)
  ) {
    problems.push("sessions summary");
  }
  if (problems.length > 0) {
    throw new Error(
      `health payload missing ${problems.join(", ")}: ${boundedJsonPreview(payload)}`,
    );
  }
}

export function assertGatewayStatusPayload(payload) {
  const status = assertObjectPayload(payload, "status");
  const problems = [];
  if (
    !status.heartbeat ||
    typeof status.heartbeat !== "object" ||
    Array.isArray(status.heartbeat) ||
    !isNonEmptyString(status.heartbeat.defaultAgentId) ||
    !Array.isArray(status.heartbeat.agents)
  ) {
    problems.push("heartbeat summary");
  }
  if (!Array.isArray(status.channelSummary)) {
    problems.push("channelSummary array");
  }
  if (!Array.isArray(status.queuedSystemEvents)) {
    problems.push("queuedSystemEvents array");
  }
  if (!status.tasks || typeof status.tasks !== "object" || Array.isArray(status.tasks)) {
    problems.push("tasks summary");
  }
  if (
    !status.taskAudit ||
    typeof status.taskAudit !== "object" ||
    Array.isArray(status.taskAudit)
  ) {
    problems.push("taskAudit summary");
  }
  if (
    !status.sessions ||
    typeof status.sessions !== "object" ||
    Array.isArray(status.sessions) ||
    !Array.isArray(status.sessions.paths) ||
    !Number.isFinite(status.sessions.count) ||
    !Array.isArray(status.sessions.recent) ||
    !Array.isArray(status.sessions.byAgent) ||
    !status.sessions.defaults ||
    typeof status.sessions.defaults !== "object" ||
    Array.isArray(status.sessions.defaults)
  ) {
    problems.push("sessions summary");
  }
  if (problems.length > 0) {
    throw new Error(
      `status payload missing ${problems.join(", ")}: ${boundedJsonPreview(payload)}`,
    );
  }
}

function countDiagnosticEvents(payload, type) {
  const summaryCount = payload.summary?.byType?.[type];
  if (Number.isFinite(summaryCount)) {
    return summaryCount;
  }
  return (Array.isArray(payload.events) ? payload.events : []).filter(
    (event) => event?.type === type,
  ).length;
}

export async function sampleProcess(pid, options = {}) {
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

export function summarizeProcessSamples(samples) {
  const validSamples = samples.filter((sample) => sample && Number.isFinite(sample.rssMiB));
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
    .filter((value) => Number.isFinite(value));
  return {
    ...peakRssSample,
    sampleCount: validSamples.length,
    peakCpuPercent:
      numericCpuSamples.length > 0 ? Math.max(...numericCpuSamples) : peakRssSample.cpuPercent,
  };
}

async function samplePosixProcess(pid, run, commandLineNeedles = []) {
  const needles = commandLineNeedles
    .map((needle) => String(needle ?? "").trim())
    .filter((needle) => needle.length > 0);
  if (needles.length > 0) {
    return samplePosixProcessTree(pid, run, needles);
  }
  return samplePosixProcessWithDescendants(pid, run);
}

async function samplePosixProcessWithDescendants(pid, run) {
  const safePid = Number(pid);
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
    const selected = rows.find((row) => row.processId === safePid);
    if (!selected) {
      return null;
    }
    const treeRows = collectPosixProcessTree(rows, safePid);
    if (hasMalformedProcessTreeRows(malformedRows, treeRows)) {
      return null;
    }
    return formatPosixProcessTreeSample(selected, treeRows);
  } catch {
    return null;
  }
}

async function samplePosixProcessTree(pid, run, commandLineNeedles) {
  const safePid = Number(pid);
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
    if (hasMalformedProcessTreeRows(malformedRows, rootTreeRows)) {
      return null;
    }
    const rootRow = rootTreeRows.find((row) => row.processId === safePid) ?? null;
    const descendants = rootTreeRows.filter((row) => row.processId !== safePid);
    const matchesCommandNeedles = (row) =>
      commandLineNeedles.every((needle) =>
        row.command.toLowerCase().includes(needle.toLowerCase()),
      );
    const commandMatches = descendants.filter(matchesCommandNeedles);
    const rootCommandMatches = rootRow && matchesCommandNeedles(rootRow) ? [rootRow] : [];
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
    if (!selected) {
      return null;
    }
    return formatPosixProcessTreeSample(
      selected,
      collectPosixProcessTree(rows, selected.processId),
    );
  } catch {
    return null;
  }
}

function parsePosixProcessRows(stdout) {
  const rows = [];
  const malformedRows = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/u);
    if (!match) {
      continue;
    }
    const [, pidRaw, ppidRaw, rssKbRaw, cpuRaw, command] = match;
    if (!/^\d/u.test(pidRaw) && !/^\d/u.test(ppidRaw)) {
      continue;
    }
    const processId = parseStrictPositiveInteger(pidRaw);
    const parentProcessId = parseStrictUnsignedInteger(ppidRaw);
    const rssKb = parseStrictPositiveInteger(rssKbRaw);
    const cpuPercent = parseStrictNonNegativeDecimal(cpuRaw);
    if (
      !Number.isInteger(processId) ||
      !Number.isInteger(parentProcessId) ||
      !Number.isInteger(rssKb)
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

function parseStrictNonNegativeDecimal(raw) {
  const text = String(raw ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseStrictUnsignedInteger(raw) {
  const text = String(raw ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseStrictPositiveInteger(raw) {
  const parsed = parseStrictUnsignedInteger(raw);
  return parsed && parsed > 0 ? parsed : null;
}

function parseTasklistMemoryKiB(raw) {
  const text = String(raw ?? "").trim();
  const match = text.match(/^((?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))\s*K$/iu);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1].replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function collectPosixProcessTree(rows, rootPid) {
  const byParent = new Map();
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

function hasMalformedProcessTreeRows(malformedRows, treeRows) {
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

function rawProcessTokenMatchesTree(raw, treePids) {
  const text = String(raw ?? "").trim();
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

function selectPeakRssProcess(rows) {
  return rows.reduce((peak, row) => (peak && peak.rssKb >= row.rssKb ? peak : row), null);
}

function formatPosixProcessSample(row) {
  return {
    rssMiB: Math.round((row.rssKb / 1024) * 10) / 10,
    aggregateRssMiB: Math.round((row.rssKb / 1024) * 10) / 10,
    cpuPercent: row.cpuPercent,
    processId: row.processId,
  };
}

function formatPosixProcessTreeSample(selected, rows) {
  const aggregateRssKb = rows.reduce((sum, row) => sum + row.rssKb, 0);
  return {
    ...formatPosixProcessSample(selected),
    aggregateRssMiB: Math.round((aggregateRssKb / 1024) * 10) / 10,
  };
}

function parseTasklistCsvLine(line) {
  const values = [];
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

async function sampleWindowsPidWithTasklist(pid, run) {
  const safePid = Number(pid);
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

export async function sampleWindowsProcessByPort(port, options = {}) {
  const safePort = Number(port);
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
      .find((candidate) => Number.isInteger(candidate) && candidate > 0);
    if (!pid) {
      return null;
    }
    return (await sampleWindowsProcess(pid, run)) ?? sampleWindowsPidWithTasklist(pid, run);
  } catch {
    return null;
  }
}

function parseWindowsNetstatListeningPid(line, port) {
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

function powershellSingleQuoted(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

async function sampleWindowsProcess(pid, run, commandLineNeedles = []) {
  const safePid = Number(pid);
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return null;
  }
  const needles = commandLineNeedles
    .map((needle) => String(needle ?? "").trim())
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

function assertProcessResourceCeiling(sample, { label, maxRssMiB, requireSample = true }) {
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

export function assertResourceCeiling(sample) {
  const config = resolveKitchenSinkRpcConfig();
  assertProcessResourceCeiling(sample, {
    label: "gateway",
    maxRssMiB: config.maxRssMiB,
  });
}

export function assertCommandResourceCeiling(sample) {
  const config = resolveKitchenSinkRpcConfig();
  assertProcessResourceCeiling(sample, {
    label: "command",
    maxRssMiB: config.commandMaxRssMiB,
  });
}

export function findErrorLogFindings(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const scanBytes = fs.statSync(logPath).size;

  const findings = [];
  let currentLine = "";
  let currentLineNumber = 1;
  let currentLineHasFinding = false;
  let currentLineTruncated = false;
  const recordLine = (lineNumber, line) => {
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
  const appendLineFragment = (fragment) => {
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

function assertNoErrorLogs(logPath) {
  const findings = findErrorLogFindings(logPath);
  if (findings.length > 0) {
    throw new Error(
      `unexpected error-like gateway logs:\n${findings
        .map(({ line, lineNumber }) => `${logPath}:${lineNumber}: ${line}`)
        .join("\n")}`,
    );
  }
}

export function tailFile(file, maxBytes = LOG_TAIL_BYTES) {
  if (!fs.existsSync(file)) {
    return "";
  }
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - Math.max(1, maxBytes));
  const length = stat.size - start;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return tailText(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function tailText(text) {
  return text.split(/\r?\n/u).slice(-120).join("\n");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export async function main() {
  const config = resolveKitchenSinkRpcConfig();
  let runner = resolveOpenClawRunner();
  const port = await resolveKitchenSinkRpcPort();
  const { root, env } = makeEnv();
  const logPath = path.join(root, "gateway.log");
  const keepTmp = process.env.OPENCLAW_KITCHEN_SINK_KEEP_TMP === "1";
  let failed = false;
  let child;

  const processSamples = [];
  const commandSamples = [];
  const commandResourceOptions = {
    resourceSampleIntervalMs: 500,
    resourceSamples: commandSamples,
  };
  let sampleInFlight = null;
  let sampleTimer;
  try {
    console.log(`Kitchen Sink RPC walk using ${PLUGIN_SPEC} via ${runner.label}`);
    await runOpenClaw(runner, ["plugins", "install", PLUGIN_SPEC, "--force"], env, {
      ...commandResourceOptions,
      requireResourceSample: true,
      resourceLabel: "plugins install",
      timeoutMs: config.installTimeoutMs,
    });
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
    if (inspect?.plugin?.status !== "loaded") {
      throw new Error(
        `Kitchen Sink plugin did not inspect as loaded: ${boundedJsonPreview(inspect)}`,
      );
    }
    const inspectPlugin = inspect.plugin ?? {};
    const inspectProviders = [
      ...(Array.isArray(inspectPlugin.providerIds) ? inspectPlugin.providerIds : []),
      ...(Array.isArray(inspectPlugin.providers) ? inspectPlugin.providers : []),
    ];
    assertIncludesAny(inspectProviders, EXPECTED_PROVIDERS, "plugins inspect providers");

    child = await startGateway(runner, port, env, logPath);
    const rpcOptions = { commandResourceOptions, env, port, runner };
    const sampleGateway = async () => {
      const gatewayCommandLineNeedles = ["gateway", "--port", String(port)];
      const processSampleOptions = runner.pnpm
        ? {
            posixCommandLineNeedles: gatewayCommandLineNeedles,
            windowsCommandLineNeedles: gatewayCommandLineNeedles,
          }
        : {};
      let sample = await sampleProcess(child.pid, processSampleOptions);
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

    await waitForGatewayReady(child, port, logPath);
    const initialSample = await sampleGateway();
    sampleTimer = setInterval(() => {
      void collectTimedSample().catch(() => {});
    }, 1000);
    sampleTimer.unref?.();
    const healthz = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    const readyz = await fetchJson(`http://127.0.0.1:${port}/readyz`);
    if (!healthz.ok || healthz.body?.status !== "live") {
      throw new Error(`/healthz did not report live: ${boundedJsonPreview(healthz)}`);
    }
    if (!readyz.ok || readyz.body?.ready !== true) {
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

    const createdSession = await retryRpcCall(
      "sessions.create",
      { key: SESSION_KEY, agentId: "main", label: "kitchen-sink-rpc" },
      rpcOptions,
    );
    assertCreatedKitchenSinkSession(createdSession);
    const effective = await retryRpcCall(
      "tools.effective",
      { sessionKey: createdSession.key, agentId: "main" },
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
          sessionKey: createdSession.key,
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
    await retryRpcCall("artifacts.list", { sessionKey: createdSession.key }, rpcOptions);
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
    await sampleInFlight?.catch(() => {});
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
    await stopGateway(child);
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

function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
