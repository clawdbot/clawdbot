// Measures gateway RPC round-trip time by launching an isolated local gateway
// and writing qa-lab-compatible summary artifacts.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import { sleep } from "./lib/sleep.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";

const DEFAULT_METHODS = ["health", "config.get"];
const DEFAULT_ITERATIONS = 10;
const SINGLE_VALUE_FLAGS = new Set(["--iterations", "--methods", "--output-dir", "--repo-root"]);
/** Maximum time to wait for a spawned gateway to become reachable. */
const READY_TIMEOUT_MS = 120_000;
/** Per-probe timeout used while polling gateway readiness endpoints. */
const READY_PROBE_TIMEOUT_MS = 1_000;
const READY_PROBE_RESPONSE_BODY_MAX_BYTES = 64 * 1024;
const GATEWAY_FORCE_KILL_GRACE_MS = 250;
const PARENT_TERMINATION_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
const IS_DIRECT_RUN =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function usage() {
  return [
    "Usage: node --import tsx scripts/measure-rpc-rtt.mjs",
    "  --output-dir <dir>",
    "  [--repo-root <openclaw-repo>]",
    "  [--iterations <count>]",
    "  [--methods <comma-separated-methods>]",
    "  [--help, -h]",
  ].join("\n");
}

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseMethodList(value) {
  const methods = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const duplicate = methods.find((method, index) => methods.indexOf(method) !== index);
  if (duplicate) {
    throw new Error(`--methods contains duplicate gateway method: ${duplicate}`);
  }
  return methods;
}

export function parseArgs(argv) {
  const args = {
    help: false,
    iterations: DEFAULT_ITERATIONS,
    methods: DEFAULT_METHODS,
  };
  const seenSingleValueFlags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (SINGLE_VALUE_FLAGS.has(arg)) {
      if (seenSingleValueFlags.has(arg)) {
        throw new Error(`${arg} was provided more than once.`);
      }
      seenSingleValueFlags.add(arg);
    }
    if (arg === "--output-dir") {
      args.outputDir = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--repo-root") {
      args.repoRoot = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--iterations") {
      args.iterations = parsePositiveInt(readFlagValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--methods") {
      args.methods = parseMethodList(readFlagValue(argv, index, arg));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (args.help) {
    return args;
  }
  if (!args.outputDir) {
    throw new Error(usage());
  }
  if (args.methods.length === 0) {
    throw new Error("--methods must include at least one gateway method.");
  }
  return args;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("failed to allocate loopback port"));
      });
    });
  });
}

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

async function readyzReportsReady(response, options = {}) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return false;
  }
  try {
    const text = await readBoundedResponseText(
      response,
      "RPC RTT /readyz",
      READY_PROBE_RESPONSE_BODY_MAX_BYTES,
      options,
    );
    const body = JSON.parse(text);
    return body && typeof body === "object" && body.ready === true;
  } catch {
    return false;
  }
}

async function fetchReadinessProbe(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error(`${url} timed out after ${timeoutMs}ms`), {
    code: "ETIMEDOUT",
  });
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return {
      clearTimeout: () => clearTimeout(timeout),
      response,
      signal: controller.signal,
      timeoutPromise,
    };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

/**
 * Polls readiness endpoints while also failing fast if the child exits.
 */
export async function waitForGatewayReady({
  child,
  fetchImpl = fetch,
  port,
  probeTimeoutMs = READY_PROBE_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  sleepMs = 250,
  stderrPath,
}) {
  const startedAt = Date.now();
  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  const getChildExit = () =>
    childExit ??
    (child.exitCode != null || child.signalCode != null
      ? { code: child.exitCode, signal: child.signalCode }
      : null);
  while (Date.now() - startedAt < readyTimeoutMs) {
    const observedExit = getChildExit();
    if (observedExit) {
      const stderr = await fs.readFile(stderrPath, "utf8").catch(() => "");
      throw new Error(
        `gateway exited before readiness code=${observedExit.code ?? "null"} signal=${observedExit.signal ?? "null"}\n${stderr.slice(-4000)}`,
      );
    }
    try {
      const probe = await fetchReadinessProbe(
        fetchImpl,
        `http://127.0.0.1:${port}/readyz`,
        probeTimeoutMs,
      );
      try {
        if (
          await readyzReportsReady(probe.response, {
            signal: probe.signal,
            timeoutPromise: probe.timeoutPromise,
          })
        ) {
          return;
        }
      } finally {
        probe.clearTimeout();
      }
    } catch {
      // The gateway may not have bound the port yet.
    }
    try {
      const probe = await fetchReadinessProbe(
        fetchImpl,
        `http://127.0.0.1:${port}/healthz`,
        probeTimeoutMs,
      );
      void probe.response.body?.cancel().catch(() => undefined);
      probe.clearTimeout();
    } catch {
      // Liveness is diagnostic only; /readyz is the usable RPC readiness contract.
    }
    await sleep(sleepMs);
  }
  const stderr = await fs.readFile(stderrPath, "utf8").catch(() => "");
  throw new Error(`gateway did not become ready after ${readyTimeoutMs}ms\n${stderr.slice(-4000)}`);
}

function isProcessAlreadyExitedError(error) {
  return error && typeof error === "object" && error.code === "ESRCH";
}

function defaultKillProcess(pid, signal) {
  return process.kill(pid, signal);
}

function defaultRunTaskkill(command, args, options) {
  return spawnSync(command, args, options);
}

async function defaultOpen(filePath, flags) {
  return await fs.open(filePath, flags);
}

function resolveOpenClawLaunchArgs(repoRoot, sourceEntryExists = existsSync) {
  const sourceEntry = path.join(repoRoot, "src", "entry.ts");
  if (sourceEntryExists(sourceEntry)) {
    return ["--import", "tsx", sourceEntry];
  }
  return [path.join(repoRoot, "openclaw.mjs")];
}

/**
 * Signals the gateway process tree so spawned package-manager children are cleaned up.
 */
export function signalGatewayProcess(
  child,
  signal,
  killProcess = defaultKillProcess,
  { platform = process.platform, runTaskkill = defaultRunTaskkill } = {},
) {
  if (platform !== "win32" && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, signal);
      return true;
    } catch (error) {
      if (isProcessAlreadyExitedError(error)) {
        return false;
      }
      throw error;
    }
  }
  if (platform === "win32" && typeof child.pid === "number") {
    const taskkillPath = resolveWindowsTaskkillPath();
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
    if (!result?.error && result?.status === 0) {
      return true;
    }
    if (signal !== "SIGKILL") {
      const forceResult = runTaskkill(taskkillPath, [...args, "/F"], { stdio: "ignore" });
      if (!forceResult?.error && forceResult?.status === 0) {
        return true;
      }
    }
  }
  try {
    return child.kill(signal);
  } catch (error) {
    if (isProcessAlreadyExitedError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Checks process-group liveness without treating an already-exited child as an error.
 */
export function isGatewayProcessAlive(
  child,
  killProcess = defaultKillProcess,
  { platform = process.platform } = {},
) {
  if (platform !== "win32" && typeof child.pid === "number") {
    try {
      killProcess(-child.pid, 0);
      return true;
    } catch (error) {
      if (isProcessAlreadyExitedError(error)) {
        return false;
      }
      throw error;
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

function signalGatewayProcessForParentExit(child, signal, killProcess, signalOptions) {
  try {
    signalGatewayProcess(child, signal, killProcess, signalOptions);
  } catch {
    // Parent shutdown cleanup is best effort; the original signal should win.
  }
}

function gatewayProcessAliveForParentExit(child, killProcess, signalOptions) {
  try {
    return isGatewayProcessAlive(child, killProcess, signalOptions);
  } catch {
    return true;
  }
}

/**
 * Installs parent-process cleanup handlers for a spawned gateway.
 */
export function installGatewayParentCleanup(
  child,
  {
    killProcess = defaultKillProcess,
    platform = process.platform,
    processLike = process,
    runTaskkill = defaultRunTaskkill,
  } = {},
) {
  const signalOptions = { platform, runTaskkill };
  const signalHandlers = new Map();
  let forceKillTimer;
  let parentSignalPending = false;
  const forceCleanup = (signal) => {
    signalGatewayProcessForParentExit(child, signal, killProcess, signalOptions);
    if (platform !== "win32") {
      signalGatewayProcessForParentExit(child, "SIGKILL", killProcess, signalOptions);
    }
  };
  const cleanupAndReraise = (signal) => {
    parentSignalPending = true;
    signalGatewayProcessForParentExit(child, signal, killProcess, signalOptions);
    const finish = () => {
      forceKillTimer = undefined;
      signalGatewayProcessForParentExit(child, "SIGKILL", killProcess, signalOptions);
      processLike.kill?.(processLike.pid, signal);
    };
    // Signal handlers can give the detached gateway group one normal teardown
    // grace window before re-raising; process exit cleanup cannot wait.
    if (
      platform === "win32" ||
      !gatewayProcessAliveForParentExit(child, killProcess, signalOptions)
    ) {
      processLike.kill?.(processLike.pid, signal);
      return;
    }
    forceKillTimer = setTimeout(finish, GATEWAY_FORCE_KILL_GRACE_MS);
  };
  const exitHandler = () => {
    forceCleanup("SIGTERM");
  };
  const removeHandlers = () => {
    if (!parentSignalPending && forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
    processLike.off?.("exit", exitHandler);
    for (const [signal, handler] of signalHandlers) {
      processLike.off?.(signal, handler);
    }
    signalHandlers.clear();
  };
  processLike.once("exit", exitHandler);
  for (const signal of PARENT_TERMINATION_SIGNALS) {
    const handler = () => {
      removeHandlers();
      cleanupAndReraise(signal);
    };
    signalHandlers.set(signal, handler);
    processLike.once(signal, handler);
  }
  return removeHandlers;
}

async function waitForGatewayExit(
  child,
  timeoutMs,
  killProcess = defaultKillProcess,
  signalOptions = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isGatewayProcessAlive(child, killProcess, signalOptions)) {
      return true;
    }
    await sleep(Math.min(25, Math.max(0, deadline - Date.now())));
  }
  return !isGatewayProcessAlive(child, killProcess, signalOptions);
}

/**
 * Stops the gateway with SIGTERM first and SIGKILL after the grace window.
 */
export async function stopGateway(child, options = {}) {
  const signalOptions = {
    platform: options.platform ?? process.platform,
    runTaskkill: options.runTaskkill ?? defaultRunTaskkill,
  };
  if (!isGatewayProcessAlive(child, options.killProcess, signalOptions)) {
    return;
  }
  const killGraceMs = Math.max(0, options.killGraceMs ?? 1_500);
  const forceKillGraceMs = Math.max(0, options.forceKillGraceMs ?? GATEWAY_FORCE_KILL_GRACE_MS);
  signalGatewayProcess(child, "SIGTERM", options.killProcess, signalOptions);
  const exited = await waitForGatewayExit(child, killGraceMs, options.killProcess, signalOptions);
  if (!exited) {
    signalGatewayProcess(child, "SIGKILL", options.killProcess, signalOptions);
    await waitForGatewayExit(child, forceKillGraceMs, options.killProcess, signalOptions);
  }
}

async function closeFileHandles(handles) {
  const results = await Promise.allSettled(handles.filter(Boolean).map((handle) => handle.close()));
  const failedClose = results.find((result) => result.status === "rejected");
  if (failedClose) {
    throw failedClose.reason;
  }
}

/**
 * Starts an isolated loopback gateway with temp HOME/state directories.
 */
export async function startGateway({
  configPath,
  env = process.env,
  openImpl = defaultOpen,
  port,
  repoRoot,
  sourceEntryExists = existsSync,
  spawnImpl = spawn,
  stderrPath,
  stdoutPath,
  tempRoot,
  token,
}) {
  const stdout = await openImpl(stdoutPath, "w");
  let stderr;
  try {
    stderr = await openImpl(stderrPath, "w");
  } catch (error) {
    try {
      await closeFileHandles([stdout]);
    } catch {}
    throw error;
  }

  let child;
  const launcherArgs = resolveOpenClawLaunchArgs(repoRoot, sourceEntryExists);
  try {
    child = spawnImpl(
      process.execPath,
      [
        ...launcherArgs,
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: repoRoot,
        detached: process.platform !== "win32",
        env: {
          ...env,
          HOME: path.join(tempRoot, "home"),
          XDG_CONFIG_HOME: path.join(tempRoot, "xdg-config"),
          XDG_DATA_HOME: path.join(tempRoot, "xdg-data"),
          XDG_CACHE_HOME: path.join(tempRoot, "xdg-cache"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_TEST_FAST: "1",
        },
        stdio: ["ignore", stdout.fd, stderr.fd],
      },
    );
  } catch (error) {
    try {
      await closeFileHandles([stdout, stderr]);
    } catch {}
    throw error;
  }

  try {
    await closeFileHandles([stdout, stderr]);
  } catch (error) {
    try {
      await stopGateway(child);
    } catch {}
    throw error;
  }

  return child;
}

/**
 * Removes the temporary root used by the RPC RTT probe.
 */
export async function cleanupTempRoot(tempRoot, { rmImpl = fs.rm } = {}) {
  try {
    await rmImpl(tempRoot, { force: true, recursive: true });
  } catch (error) {
    throw new Error(`failed to remove RPC RTT temp root: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
}

async function copyLogIfPresent(source, target) {
  try {
    await fs.copyFile(source, target);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function copyGatewayLogs({ outputDir, stderrPath, stdoutPath }) {
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    copyLogIfPresent(stdoutPath, path.join(outputDir, "gateway.stdout.log")),
    copyLogIfPresent(stderrPath, path.join(outputDir, "gateway.stderr.log")),
  ]);
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

function roundMeasuredMs(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite duration.`);
  }
  return Math.max(1, Math.round(value));
}

export function summarizeRttSamples(samples) {
  if (samples.length === 0) {
    throw new Error("RPC RTT measurement produced no samples.");
  }
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    avgMs: roundMeasuredMs(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, "avgMs"),
    maxMs: roundMeasuredMs(sorted.at(-1), "maxMs"),
    minMs: roundMeasuredMs(sorted[0], "minMs"),
    p50Ms: roundMeasuredMs(quantile(sorted, 0.5), "p50Ms"),
    p95Ms: roundMeasuredMs(quantile(sorted, 0.95), "p95Ms"),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPayloadObject(method, payload) {
  if (!isRecord(payload)) {
    throw new Error(`${method} returned invalid payload: expected object.`);
  }
  return payload;
}

function assertHealthSmokePayload(payload) {
  const summary = assertPayloadObject("health", payload);
  if (summary.ok !== true) {
    throw new Error("health returned invalid payload: expected ok=true.");
  }
  if (!Number.isFinite(summary.ts)) {
    throw new Error("health returned invalid payload: expected numeric ts.");
  }
  if (!Number.isFinite(summary.durationMs)) {
    throw new Error("health returned invalid payload: expected numeric durationMs.");
  }
  if (typeof summary.defaultAgentId !== "string" || summary.defaultAgentId.trim() === "") {
    throw new Error("health returned invalid payload: expected defaultAgentId.");
  }
  if (!Array.isArray(summary.agents)) {
    throw new Error("health returned invalid payload: expected agents array.");
  }
  if (!isRecord(summary.channels)) {
    throw new Error("health returned invalid payload: expected channels object.");
  }
  if (!Array.isArray(summary.channelOrder)) {
    throw new Error("health returned invalid payload: expected channelOrder array.");
  }
  if (!isRecord(summary.sessions)) {
    throw new Error("health returned invalid payload: expected sessions object.");
  }
}

function assertConfigGetSmokePayload(payload) {
  const snapshot = assertPayloadObject("config.get", payload);
  if (typeof snapshot.path !== "string" || snapshot.path.trim() === "") {
    throw new Error("config.get returned invalid payload: expected config path.");
  }
  if (typeof snapshot.exists !== "boolean") {
    throw new Error("config.get returned invalid payload: expected exists boolean.");
  }
  if (typeof snapshot.valid !== "boolean") {
    throw new Error("config.get returned invalid payload: expected valid boolean.");
  }
  if (!isRecord(snapshot.sourceConfig)) {
    throw new Error("config.get returned invalid payload: expected sourceConfig object.");
  }
  if (!isRecord(snapshot.resolved)) {
    throw new Error("config.get returned invalid payload: expected resolved object.");
  }
  if (!isRecord(snapshot.runtimeConfig)) {
    throw new Error("config.get returned invalid payload: expected runtimeConfig object.");
  }
  if (!isRecord(snapshot.config)) {
    throw new Error("config.get returned invalid payload: expected config object.");
  }
  if (!Array.isArray(snapshot.issues)) {
    throw new Error("config.get returned invalid payload: expected issues array.");
  }
  if (!Array.isArray(snapshot.warnings)) {
    throw new Error("config.get returned invalid payload: expected warnings array.");
  }
  if (!Array.isArray(snapshot.legacyIssues)) {
    throw new Error("config.get returned invalid payload: expected legacyIssues array.");
  }
}

export function assertRpcSmokeResponse(method, response) {
  if (!response?.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(response?.error)}`);
  }
  if (method === "health") {
    assertHealthSmokePayload(response.payload);
    return;
  }
  if (method === "config.get") {
    assertConfigGetSmokePayload(response.payload);
  }
}

function toText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

export function createGatewayClient({ WebSocket, openTimeoutMs = 8_000, url }) {
  const ws = new WebSocket(url, { handshakeTimeout: 8_000 });
  const pending = new Map();
  const rejectPending = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    pending.clear();
  };
  ws.on("message", (data) => {
    let frame;
    try {
      frame = JSON.parse(toText(data));
    } catch {
      return;
    }
    if (frame?.type === "res") {
      const waiter = pending.get(frame.id);
      if (!waiter) {
        return;
      }
      pending.delete(frame.id);
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
    }
  });
  ws.on("close", (code, reason) => {
    rejectPending(new Error(`gateway websocket closed (${code}): ${toText(reason)}`));
  });
  ws.on("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });
  const waitOpen = async () =>
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.off?.("open", onOpen);
        ws.off?.("error", onError);
        ws.off?.("close", onClose);
        callback();
      };
      const onOpen = () => settle(resolve);
      const onError = (error) =>
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      const onClose = (code, reason) =>
        settle(() => {
          const text = toText(reason);
          const suffix = text.length > 0 ? `: ${text}` : "";
          reject(new Error(`closed before open (${code})${suffix}`));
        });
      const timer = setTimeout(() => {
        settle(() => {
          if (typeof ws.terminate === "function") {
            ws.terminate();
          } else {
            ws.close();
          }
          reject(new Error("gateway websocket open timeout"));
        });
      }, openTimeoutMs);
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  const request = async (method, params, timeoutMs = 10_000) =>
    await new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`gateway websocket is not open for ${method}`));
        return;
      }
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      const rejectSendFailure = (error) => {
        if (!error) {
          return;
        }
        pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        ws.send(JSON.stringify({ type: "req", id, method, params }), rejectSendFailure);
      } catch (error) {
        rejectSendFailure(error);
      }
    });
  const close = () => {
    rejectPending(new Error("gateway websocket client closed"));
    ws.close();
  };
  return { close, request, waitOpen };
}

async function writeSummary({
  details,
  events,
  finishedAt,
  outputDir,
  measurement,
  startedAt,
  status,
}) {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "rpc-events.json"),
    `${JSON.stringify(events, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outputDir, "qa-suite-summary.json"),
    `${JSON.stringify(
      {
        counts: {
          total: 1,
          passed: status === "pass" ? 1 : 0,
          failed: status === "pass" ? 0 : 1,
        },
        run: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          providerMode: "gateway-rpc",
          scenarioIds: ["rpc-gateway-smoke"],
        },
        scenarios: [
          {
            id: "rpc-gateway-smoke",
            title: "Gateway RPC loopback smoke",
            status,
            details,
            ...(measurement ? { rttMeasurement: measurement } : {}),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const repoRoot = path.resolve(args.repoRoot ?? process.env.OPENCLAW_REPO_ROOT ?? process.cwd());
  const outputDir = path.resolve(args.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(outputDir, "..", ".rpc-rtt-"));
  const startedAt = new Date();
  const token = `rpc-rtt-${randomUUID()}`;
  const port = await getFreePort();
  const configPath = path.join(tempRoot, "openclaw.json");
  const stdoutPath = path.join(tempRoot, "gateway.stdout.log");
  const stderrPath = path.join(tempRoot, "gateway.stderr.log");
  let gatewayChild;
  let client;
  let removeGatewayParentCleanup = () => {};
  let status = "fail";
  let details = "";
  let measurement;
  let cleanupError;
  const events = [];
  try {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          gateway: {
            mode: "local",
            bind: "loopback",
            port,
            auth: { mode: "token", token },
            controlUi: { enabled: false },
          },
          plugins: { enabled: false },
        },
        null,
        2,
      )}\n`,
    );
    gatewayChild = await startGateway({
      configPath,
      port,
      repoRoot,
      stderrPath,
      stdoutPath,
      tempRoot,
      token,
    });
    removeGatewayParentCleanup = installGatewayParentCleanup(gatewayChild);
    await waitForGatewayReady({ child: gatewayChild, port, stderrPath });

    const requireFromOpenClaw = createRequire(path.join(repoRoot, "package.json"));
    const WebSocket = requireFromOpenClaw("ws");
    const protocol = await import(
      pathToFileURL(path.join(repoRoot, "packages/gateway-protocol/src/version.ts")).href
    );
    client = createGatewayClient({ WebSocket, url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    const connectStarted = performance.now();
    const connect = await client.request(
      "connect",
      {
        minProtocol: protocol.MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: protocol.PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "openclaw-rtt rpc probe",
          version: "rtt",
          platform: process.platform,
          mode: "backend",
          instanceId: `openclaw-rtt-rpc-${randomUUID()}`,
        },
        locale: "en-US",
        userAgent: "openclaw-rtt-rpc",
        role: "operator",
        scopes: ["operator.admin"],
        caps: [],
        auth: { token },
      },
      10_000,
    );
    if (!connect.ok) {
      throw new Error(`connect failed: ${JSON.stringify(connect.error)}`);
    }
    events.push({
      event: "gateway-rpc.connect",
      payload: {
        method: "connect",
        ok: true,
        durationMs: roundMeasuredMs(performance.now() - connectStarted, "connect durationMs"),
      },
    });
    const samples = [];
    for (const method of args.methods) {
      for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
        const requestStartedAtMs = performance.now();
        const response = await client.request(method, {}, 10_000);
        const durationMs = performance.now() - requestStartedAtMs;
        const roundedDurationMs = roundMeasuredMs(durationMs, `${method} durationMs`);
        assertRpcSmokeResponse(method, response);
        samples.push({ method, durationMs });
        events.push({
          event: "gateway-rpc",
          payload: {
            kind: "gateway-rpc",
            method,
            ok: true,
            durationMs: roundedDurationMs,
            iteration,
          },
        });
      }
    }
    const sampleStats = summarizeRttSamples(samples.map((sample) => sample.durationMs));
    const byMethod = Object.fromEntries(
      args.methods.map((method) => [
        method,
        summarizeRttSamples(
          samples.filter((sample) => sample.method === method).map((sample) => sample.durationMs),
        ),
      ]),
    );
    measurement = {
      finalMatchedReplyRttMs: sampleStats.p50Ms,
      durationMs: sampleStats.p50Ms,
      method: args.methods.join(","),
      source: "gateway-rpc",
    };
    details = JSON.stringify({
      iterations: args.iterations,
      methods: args.methods,
      stats: sampleStats,
      byMethod,
    });
    status = "pass";
  } catch (error) {
    details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    try {
      client?.close();
      if (gatewayChild) {
        await stopGateway(gatewayChild).catch(() => {});
      }
    } finally {
      removeGatewayParentCleanup();
    }
    try {
      await copyGatewayLogs({ outputDir, stderrPath, stdoutPath });
    } catch (error) {
      const message = formatErrorMessage(error);
      details = details
        ? `${details}\nwarning: failed to copy gateway logs: ${message}`
        : `warning: failed to copy gateway logs: ${message}`;
    }
    try {
      await cleanupTempRoot(tempRoot);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    const cleanupDetails = formatErrorMessage(cleanupError);
    details = details ? `${details}\n${cleanupDetails}` : cleanupDetails;
    status = "fail";
  }
  const finishedAt = new Date();
  await writeSummary({ details, events, finishedAt, outputDir, measurement, startedAt, status });
  if (status !== "pass") {
    throw new Error(details || "RPC RTT measurement failed");
  }
}

if (IS_DIRECT_RUN) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
