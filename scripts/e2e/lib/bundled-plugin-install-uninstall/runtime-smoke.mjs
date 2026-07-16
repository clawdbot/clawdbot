// Runtime smoke script for bundled plugin install/uninstall E2E validation.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveWindowsTaskkillPath } from "../../../lib/windows-taskkill.mjs";
import { readBoundedResponseText } from "../bounded-response-text.mjs";

const TOKEN = "bundled-plugin-runtime-smoke-token";
const RUNTIME_PORT_BASE_ENV = "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE";
const TCP_PORT_MAX = 65535;
const OUTPUT_CAPTURE_CHARS = readPositiveIntEnv(
  "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS",
  1024 * 1024,
);
const LOG_SCAN_BYTES = readPositiveIntEnv(
  "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES",
  256 * 1024,
);
const GATEWAY_LOG_CAPTURE_BYTES = readPositiveIntEnv(
  "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_GATEWAY_LOG_BYTES",
  16 * 1024 * 1024,
);
const WATCHDOG_MS = readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_WATCHDOG_MS", 1000);
const READY_TIMEOUT_MS = readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS", 900000);
const RPC_TIMEOUT_MS = readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_MS", 60000);
const RPC_READY_TIMEOUT_MS = readPositiveIntEnv(
  "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS",
  210000,
);
const COMMAND_TIMEOUT_MS = readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_COMMAND_MS", 120000);
const HTTP_PROBE_TIMEOUT_MS = readPositiveIntEnv("OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS", 5000);
const HTTP_PROBE_BODY_MAX_BYTES = 1024 * 1024;
const GATEWAY_TEARDOWN_GRACE_MS = readPositiveIntEnv(
  "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_GRACE_MS",
  10000,
);
const GATEWAY_TEARDOWN_KILL_GRACE_MS = readPositiveIntEnv(
  "OPENCLAW_BUNDLED_PLUGIN_RUNTIME_TEARDOWN_KILL_GRACE_MS",
  1000,
);
const GATEWAY_READY_LOG_NEEDLE = Buffer.from("[gateway] ready");
const READY_OFFSET_LOG_NEEDLES = [
  GATEWAY_READY_LOG_NEEDLE,
  Buffer.from("listening on ws://"),
  Buffer.from("[gateway] http server listening"),
];
const GATEWAY_LOG_TRUNCATED_NEEDLE = "[gateway log truncated after ";
const FORBIDDEN_POST_READY_DEPS_WORK = [/\b(?:npm|pnpm|yarn|corepack) install\b/iu];
const PACKAGE_MANAGER_PROCESS_BASENAME = /^(?:npm|pnpm|yarn|corepack)(?:$|[.-])/u;
const PROCESS_SNAPSHOT_ARGS = ["-ww", "-eo", "pid=,ppid=,args="];
const isolatedStateRoots = new WeakMap();
const activeCommandChildren = new Set();
const activeGatewayChildren = new Set();
const parentSignalHandlers = new Map();
let parentCleanupInstalled = false;

function readPositiveIntEnv(name, fallback) {
  return readPositiveInt(process.env[name], fallback, name);
}

function readPositiveInt(raw, fallback, name) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return fallback;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return parsed;
}

function readNonNegativeInt(raw, fallback, name) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return fallback;
  }
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return parsed;
}

export function resolveRuntimeSmokePort(pluginIndex, offset = 0, env = process.env) {
  const base = readPositiveInt(env[RUNTIME_PORT_BASE_ENV], 19000, RUNTIME_PORT_BASE_ENV);
  const port = base + pluginIndex * 3 + offset;
  if (!Number.isSafeInteger(port) || port > TCP_PORT_MAX) {
    throw new Error(
      `${RUNTIME_PORT_BASE_ENV} with bundled plugin runtime index ${pluginIndex} and offset ${offset} must resolve to a TCP port from 1 to 65535. Got: ${port}`,
    );
  }
  return port;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readFileChunk(file, startOffset, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { buffer: Buffer.alloc(0), startOffset: 0, size: 0 };
  }
  if (!stat.isFile() || stat.size <= 0) {
    return { buffer: Buffer.alloc(0), startOffset: 0, size: stat.size };
  }

  const safeMaxBytes = Math.max(1, Math.floor(Number(maxBytes) || LOG_SCAN_BYTES));
  const safeStartOffset = Math.min(Math.max(0, Math.floor(Number(startOffset) || 0)), stat.size);
  const bytesToRead = Math.min(safeMaxBytes, stat.size - safeStartOffset);
  if (bytesToRead <= 0) {
    return { buffer: Buffer.alloc(0), startOffset: safeStartOffset, size: stat.size };
  }

  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(file, "r");
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, safeStartOffset);
    return { buffer: buffer.subarray(0, bytesRead), startOffset: safeStartOffset, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

function readFileTailBuffer(file, maxBytes = LOG_SCAN_BYTES) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { buffer: Buffer.alloc(0), startOffset: 0, size: 0 };
  }
  const safeMaxBytes = Math.max(1, Math.floor(Number(maxBytes) || LOG_SCAN_BYTES));
  const startOffset = Math.max(0, stat.size - safeMaxBytes);
  return readFileChunk(file, startOffset, safeMaxBytes);
}

export function readFileTail(file, maxBytes = LOG_SCAN_BYTES) {
  return readFileTailBuffer(file, maxBytes).buffer.toString("utf8");
}

function findFirstNeedleOffset(file, needles) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return 0;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return 0;
  }

  const carryBytes = Math.max(0, ...needles.map((needle) => needle.length - 1));
  const chunk = Buffer.alloc(Math.min(LOG_SCAN_BYTES, stat.size));
  const fd = fs.openSync(file, "r");
  let carry = Buffer.alloc(0);
  let offset = 0;
  try {
    while (offset < stat.size) {
      const bytesToRead = Math.min(chunk.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, chunk, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      const view = chunk.subarray(0, bytesRead);
      const combined = carry.length > 0 ? Buffer.concat([carry, view]) : view;
      const combinedOffset = offset - carry.length;
      const indexes = needles
        .map((needle) => combined.indexOf(needle))
        .filter((index) => index >= 0);
      if (indexes.length > 0) {
        return combinedOffset + Math.min(...indexes);
      }
      carry = combined.subarray(Math.max(0, combined.length - carryBytes));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

export function createReadyLogScanner(file) {
  const carryBytes = GATEWAY_READY_LOG_NEEDLE.length - 1;
  let carry = Buffer.alloc(0);
  let offset = 0;
  let seen = false;

  return () => {
    if (seen) {
      return true;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size <= 0) {
      return false;
    }
    if (stat.size < offset) {
      carry = Buffer.alloc(0);
      offset = 0;
    }
    while (offset < stat.size) {
      const { buffer } = readFileChunk(file, offset, LOG_SCAN_BYTES);
      if (buffer.length === 0) {
        break;
      }
      const combined = carry.length > 0 ? Buffer.concat([carry, buffer]) : buffer;
      const matched = combined.includes(GATEWAY_READY_LOG_NEEDLE);
      if (matched) {
        seen = true;
        return true;
      }
      carry = combined.subarray(Math.max(0, combined.length - carryBytes));
      offset += buffer.length;
    }
    return false;
  };
}

function manifestPath(pluginDir, pluginRoot) {
  const candidates = [
    ...(isNonEmptyString(pluginRoot) ? [path.join(pluginRoot, "openclaw.plugin.json")] : []),
    path.join(process.cwd(), "dist", "extensions", pluginDir, "openclaw.plugin.json"),
    path.join(process.cwd(), "dist-runtime", "extensions", pluginDir, "openclaw.plugin.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function loadManifest(pluginDir, pluginRoot) {
  const file = manifestPath(pluginDir, pluginRoot);
  if (!fs.existsSync(file)) {
    throw new Error(`missing bundled plugin manifest: ${file}`);
  }
  return readJson(file);
}

function configPathFromEnv(env = process.env) {
  return (
    env.OPENCLAW_CONFIG_PATH || path.join(env.HOME || os.homedir(), ".openclaw", "openclaw.json")
  );
}

function readConfig(env = process.env) {
  const configPath = configPathFromEnv(env);
  return fs.existsSync(configPath) ? readJson(configPath) : {};
}

function writeConfig(config, env = process.env) {
  writeJson(configPathFromEnv(env), config);
}

function ensureGatewayConfig(config, port) {
  return {
    ...config,
    gateway: {
      ...config.gateway,
      port,
      bind: "loopback",
      auth: {
        mode: "token",
        token: TOKEN,
      },
      controlUi: {
        ...config.gateway?.controlUi,
        enabled: false,
      },
    },
  };
}

export function activateSmokePlugin(config, pluginId, channels = []) {
  const allow = Array.isArray(config.plugins?.allow)
    ? Array.from(new Set([...config.plugins.allow, pluginId].filter(isNonEmptyString)))
    : undefined;
  const channelConfig = { ...config.channels };
  for (const channel of channels) {
    channelConfig[channel] = {
      ...(typeof channelConfig[channel] === "object" && channelConfig[channel] !== null
        ? channelConfig[channel]
        : {}),
      enabled: true,
    };
  }
  return {
    ...config,
    ...(channels.length > 0 ? { channels: channelConfig } : {}),
    plugins: {
      ...config.plugins,
      enabled: true,
      ...(allow ? { allow } : {}),
      entries: {
        ...config.plugins?.entries,
        [pluginId]: {
          ...config.plugins?.entries?.[pluginId],
          enabled: true,
        },
      },
    },
  };
}

function channelActivationEnvName(channel) {
  return `${channel
    .replace(/[^a-z0-9]+/giu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase()}_RUNTIME_SMOKE`;
}

export function withManifestChannelActivationEnv(env, channels = []) {
  const nextEnv = { ...env };
  for (const channel of channels) {
    if (!isNonEmptyString(channel)) {
      continue;
    }
    const key = channelActivationEnvName(channel);
    if (key === "_RUNTIME_SMOKE") {
      continue;
    }
    nextEnv[key] ??= "1";
  }
  return nextEnv;
}

function buildPluginPlan(manifest) {
  const contracts =
    manifest.contracts && typeof manifest.contracts === "object" ? manifest.contracts : {};
  const commandAliases = Array.isArray(manifest.commandAliases) ? manifest.commandAliases : [];
  const channels = Array.isArray(manifest.channels)
    ? manifest.channels.filter(isNonEmptyString)
    : [];
  const speechProviders = Array.isArray(contracts.speechProviders)
    ? contracts.speechProviders.filter(isNonEmptyString)
    : [];
  const tools = Array.isArray(contracts.tools) ? contracts.tools.filter(isNonEmptyString) : [];
  const toolMetadata =
    manifest.toolMetadata && typeof manifest.toolMetadata === "object" ? manifest.toolMetadata : {};
  const activeInThisProbe =
    manifest.activation?.onStartup === true || channels.length > 0 || speechProviders.length > 0;
  return {
    channels,
    speechProviders,
    tools: tools.filter((tool) => !toolMetadata[tool]),
    activeInThisProbe,
    runtimeSlashAliases: commandAliases
      .filter((alias) => alias?.kind === "runtime-slash")
      .map((alias) => alias?.name)
      .filter(isNonEmptyString),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function appendBoundedOutput(buffer, chunk, maxChars = OUTPUT_CAPTURE_CHARS) {
  const nextText = buffer.text + String(chunk);
  if (nextText.length <= maxChars) {
    return { text: nextText, truncatedChars: buffer.truncatedChars };
  }
  const truncatedChars = buffer.truncatedChars + nextText.length - maxChars;
  return { text: nextText.slice(-maxChars), truncatedChars };
}

function formatCapturedOutput(label, buffer) {
  if (!buffer.text) {
    return "";
  }
  const prefix =
    buffer.truncatedChars > 0
      ? `[${label} truncated ${buffer.truncatedChars} chars; showing tail]\n`
      : "";
  return `${prefix}${buffer.text}`;
}

function createBoundedGatewayLog(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "w");
  let bytes = 0;
  let closed = false;
  let truncated = false;
  const marker = Buffer.from(
    `\n[gateway log truncated after ${String(GATEWAY_LOG_CAPTURE_BYTES)} bytes]\n`,
  );
  return {
    append(chunk) {
      if (closed || truncated) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = GATEWAY_LOG_CAPTURE_BYTES - bytes;
      if (buffer.length <= remaining) {
        fs.writeSync(fd, buffer);
        bytes += buffer.length;
        return;
      }
      if (remaining > 0) {
        fs.writeSync(fd, buffer.subarray(0, remaining));
      }
      fs.writeSync(fd, marker);
      bytes = GATEWAY_LOG_CAPTURE_BYTES;
      truncated = true;
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      fs.closeSync(fd);
    },
  };
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
    const detached = spawnOptions.detached ?? process.platform !== "win32";
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
      detached,
    });
    if (detached) {
      trackCommandChild(child);
    }
    let stdout = { text: "", truncatedChars: 0 };
    let stderr = { text: "", truncatedChars: 0 };
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    const clearCommandTimer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          signalChildProcessTree(child, "SIGKILL");
        }, timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (clearCommandTimer) {
        clearTimeout(clearCommandTimer);
      }
      reject(toLintErrorObject(error, "Command spawn failed"));
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (clearCommandTimer) {
        clearTimeout(clearCommandTimer);
      }
      if (status === 0) {
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
      const outcome = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `failed with ${signal || status}`;
      reject(new Error(`${command} ${args.join(" ")} ${outcome}${detail ? `\n${detail}` : ""}`));
    });
  });
}

export function startGateway(params) {
  const log = createBoundedGatewayLog(params.logPath);
  const child = childProcess.spawn(
    "node",
    [
      params.entrypoint,
      "gateway",
      "--port",
      String(params.port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      env: {
        ...process.env,
        ...params.env,
        OPENCLAW_NO_ONBOARD: "1",
        OPENCLAW_SKIP_CHANNELS: params.skipChannels ? "1" : "0",
        OPENCLAW_SKIP_PROVIDERS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  child.stdout?.on("data", (chunk) => log.append(chunk));
  child.stderr?.on("data", (chunk) => log.append(chunk));
  child.once("error", () => log.close());
  child.once("close", () => log.close());
  trackGatewayChild(child);
  return child;
}

export function hasChildExited(child) {
  return child.exitCode !== null || (child.signalCode ?? null) !== null;
}

function trackGatewayChild(child) {
  activeGatewayChildren.add(child);
  const untrack = () => {
    if (!processTreeIsAlive(child)) {
      activeGatewayChildren.delete(child);
    }
  };
  child.once("error", untrack);
  child.once("close", untrack);
  installParentCleanup();
}

function trackCommandChild(child) {
  activeCommandChildren.add(child);
  const untrack = () => {
    if (!processTreeIsAlive(child)) {
      activeCommandChildren.delete(child);
    }
  };
  child.once("error", untrack);
  child.once("close", untrack);
  installParentCleanup();
}

function installParentCleanup() {
  if (!parentCleanupInstalled) {
    parentCleanupInstalled = true;
    process.once("exit", () => {
      cleanupActiveChildren("SIGTERM");
    });
  }
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    if (parentSignalHandlers.has(signal)) {
      continue;
    }
    const handler = () => {
      cleanupActiveChildren(signal);
      for (const [registeredSignal, registeredHandler] of parentSignalHandlers) {
        process.off(registeredSignal, registeredHandler);
      }
      parentSignalHandlers.clear();
      process.kill(process.pid, signal);
    };
    parentSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function cleanupActiveChildren(signal) {
  for (const child of activeCommandChildren) {
    signalChildProcessTree(child, signal);
    if (process.platform !== "win32") {
      signalChildProcessTree(child, "SIGKILL");
    }
  }
  for (const child of activeGatewayChildren) {
    signalChildProcessTree(child, signal);
    if (process.platform !== "win32") {
      signalChildProcessTree(child, "SIGKILL");
    }
  }
}

export async function stopGateway(child) {
  if (!child || !processTreeIsAlive(child)) {
    return;
  }
  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!processTreeIsAlive(child)) {
        return true;
      }
      await delay(100);
    }
    return !processTreeIsAlive(child);
  };

  signalChildProcessTree(child, "SIGTERM");
  if (await waitForExit(GATEWAY_TEARDOWN_GRACE_MS)) {
    return;
  }
  signalChildProcessTree(child, "SIGKILL");
  await waitForExit(GATEWAY_TEARDOWN_KILL_GRACE_MS);
}

function processTreeIsAlive(child) {
  if (!child || typeof child.pid !== "number") {
    return !hasChildExited(child);
  }
  if (process.platform === "win32") {
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

function defaultRunTaskkill(command, args, options) {
  return childProcess.spawnSync(command, args, options);
}

export function signalChildProcessTree(
  child,
  signal,
  { platform = process.platform, runTaskkill = defaultRunTaskkill } = {},
) {
  if (platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Non-detached callers may not own a process group keyed by child.pid; keep
      // the legacy direct-child kill path as the fallback.
    }
  }
  if (platform === "win32" && typeof child.pid === "number") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") {
      args.push("/F");
    }
    const taskkillPath = resolveWindowsTaskkillPath();
    const result = runTaskkill(taskkillPath, args, { stdio: "ignore" });
    if (!result?.error && result?.status === 0) {
      return;
    }
    if (signal !== "SIGKILL") {
      const forceResult = runTaskkill(taskkillPath, [...args, "/F"], { stdio: "ignore" });
      if (!forceResult?.error && forceResult?.status === 0) {
        return;
      }
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

export async function waitForReady(params) {
  const started = Date.now();
  let lastError = "";
  const readyLogSeen = createReadyLogScanner(params.logPath);
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const remainingMs = Math.max(1, READY_TIMEOUT_MS - (Date.now() - started));
    if (hasChildExited(params.child)) {
      throw new Error(`gateway exited before ready\n${tailFile(params.logPath)}`);
    }
    try {
      const res = await fetchHttpProbeStatus(params.port, "/readyz", {
        timeoutMs: Math.min(HTTP_PROBE_TIMEOUT_MS, remainingMs),
      });
      if (res.ok) {
        return;
      }
      lastError = `readyz status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const healthRemainingMs = Math.max(1, READY_TIMEOUT_MS - (Date.now() - started));
    if (
      readyLogSeen() &&
      (await httpOk(params.port, "/healthz", {
        timeoutMs: Math.min(HTTP_PROBE_TIMEOUT_MS, healthRemainingMs),
      }))
    ) {
      return;
    }
    await delay(Math.min(250, Math.max(1, READY_TIMEOUT_MS - (Date.now() - started))));
  }
  throw new Error(`gateway did not become ready: ${lastError}\n${tailFile(params.logPath)}`);
}

async function fetchHttpProbeStatus(port, pathName, options = {}) {
  const { parseJson = false, timeoutMs = HTTP_PROBE_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeoutError = Object.assign(
    new Error(`${pathName} probe timed out after ${timeoutMs}ms`),
    {
      code: "ETIMEDOUT",
    },
  );
  let clearProbeTimer;
  const timeoutPromise = timeoutMs
    ? new Promise((_, reject) => {
        clearProbeTimer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
        clearProbeTimer.unref?.();
      })
    : undefined;
  try {
    const res = await Promise.race([
      fetch(`http://127.0.0.1:${port}${pathName}`, {
        signal: controller.signal,
      }),
      ...(timeoutPromise ? [timeoutPromise] : []),
    ]);
    const status = { ok: res.ok, status: res.status, body: undefined, bodyText: undefined };
    if (parseJson) {
      const text = await readBoundedResponseText(
        res,
        `${pathName} probe`,
        HTTP_PROBE_BODY_MAX_BYTES,
        timeoutPromise,
      );
      status.bodyText = text;
      if (text.trim()) {
        try {
          status.body = JSON.parse(text);
        } catch {
          status.body = undefined;
        }
      }
      return status;
    }
    await res.body?.cancel().catch(() => {});
    return status;
  } finally {
    if (clearProbeTimer) {
      clearTimeout(clearProbeTimer);
    }
  }
}

export async function httpOk(port, pathName, options = {}) {
  try {
    const res = await fetchHttpProbeStatus(port, pathName, options);
    return res.ok;
  } catch {
    return false;
  }
}

async function assertHttpOk(port, pathName) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < RPC_READY_TIMEOUT_MS) {
    try {
      const res = await fetchHttpProbeStatus(port, pathName);
      if (res.ok) {
        return;
      }
      lastError = new Error(`${pathName} returned HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(500, Math.max(1, RPC_READY_TIMEOUT_MS - (Date.now() - started))));
  }
  throw toLintErrorObject(
    lastError ?? new Error(`${pathName} did not return HTTP 200`),
    "Non-Error thrown",
  );
}

function listReadyzFailingComponents(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  if (body.ready !== false || !Array.isArray(body.failing)) {
    return undefined;
  }
  const failing = body.failing.filter((entry) => typeof entry === "string" && entry.length > 0);
  if (failing.length !== body.failing.length || failing.length === 0) {
    return undefined;
  }
  return failing;
}

function isAllowedDegradedReadyz(res, allowedFailures) {
  if (res.status !== 503 || allowedFailures.size === 0) {
    return false;
  }
  const failing = listReadyzFailingComponents(res.body);
  if (!failing) {
    return false;
  }
  return failing.every((entry) => allowedFailures.has(entry));
}

function formatHttpProbeBody(res) {
  if (res.body !== undefined) {
    return JSON.stringify(res.body);
  }
  const text = typeof res.bodyText === "string" ? res.bodyText.trim() : "";
  if (!text) {
    return "null";
  }
  return JSON.stringify(text.length > 500 ? `${text.slice(0, 500)}...` : text);
}

export async function assertReadyzProbe(options) {
  const allowedFailures = new Set(options.allowedDegradedReadyzFailures ?? []);
  const started = Date.now();
  let lastError;
  while (Date.now() - started < RPC_READY_TIMEOUT_MS) {
    try {
      const res = await fetchHttpProbeStatus(options.port, "/readyz", { parseJson: true });
      if (res.ok) {
        return;
      }
      if (isAllowedDegradedReadyz(res, allowedFailures)) {
        console.log(
          `Runtime readyz smoke degraded for ${options.pluginId}: /readyz failing ${JSON.stringify(
            listReadyzFailingComponents(res.body),
          )}`,
        );
        return;
      }
      lastError = new Error(`/readyz returned HTTP ${res.status}: ${formatHttpProbeBody(res)}`);
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(500, Math.max(1, RPC_READY_TIMEOUT_MS - (Date.now() - started))));
  }
  throw toLintErrorObject(
    lastError ?? new Error("/readyz did not return HTTP 200"),
    "Non-Error thrown",
  );
}

export async function rpcCall(method, params, options) {
  const rpcStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-rpc-"));
  const args = [
    options.entrypoint,
    "gateway",
    "call",
    method,
    "--url",
    `ws://127.0.0.1:${options.port}`,
    "--token",
    TOKEN,
    "--timeout",
    String(RPC_TIMEOUT_MS),
    "--json",
    "--params",
    JSON.stringify(params ?? {}),
  ];
  try {
    const { stdout } = await runCommand("node", args, {
      env: {
        ...process.env,
        ...options.env,
        OPENCLAW_NO_ONBOARD: "1",
        OPENCLAW_STATE_DIR: rpcStateDir,
      },
    });
    return unwrapRpcPayload(parseJsonOutput(stdout));
  } finally {
    fs.rmSync(rpcStateDir, { force: true, recursive: true });
  }
}

async function retryRpcCall(method, params, options) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < RPC_READY_TIMEOUT_MS) {
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
    text.includes("gateway starting") ||
    text.includes("gateway closed") ||
    text.includes("handshake timeout") ||
    text.includes("GatewayTransportError") ||
    text.includes("ECONNREFUSED") ||
    text.includes("fetch failed")
  );
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("gateway call produced no JSON output");
  }
  const parsed = parseJsonValue(trimmed);
  if (parsed.ok) {
    return parsed.value;
  }

  let lastParsed;
  const lines = trimmed.split(/\r?\n/u);
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!lines[start].trimStart().startsWith("{")) {
      continue;
    }
    let candidate = "";
    for (let end = start; end < lines.length; end += 1) {
      candidate = candidate ? `${candidate}\n${lines[end]}` : lines[end];
      const candidateParsed = parseJsonValue(candidate);
      if (!candidateParsed.ok) {
        continue;
      }
      lastParsed ??= candidateParsed.value;
      if (isGatewayJsonOutput(candidateParsed.value)) {
        return candidateParsed.value;
      }
      break;
    }
  }
  if (lastParsed !== undefined) {
    return lastParsed;
  }
  throw new Error(`gateway call JSON output was not parseable:\n${trimmed}`);
}

function parseJsonValue(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isGatewayJsonOutput(raw) {
  return (
    raw?.ok === false ||
    hasOwnPayloadField(raw, "result") ||
    hasOwnPayloadField(raw, "payload") ||
    hasOwnPayloadField(raw, "data")
  );
}

function hasOwnPayloadField(raw, field) {
  return (
    ((typeof raw === "object" && raw !== null) || typeof raw === "function") &&
    Object.hasOwn(raw, field)
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unwrapRpcPayload(raw) {
  if (raw?.ok === false) {
    throw new Error(`gateway RPC failed: ${JSON.stringify(raw.error ?? raw)}`);
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

export function assertGatewayHealthPayload(payload, label = "health") {
  if (!isRecord(payload)) {
    throw new Error(`${label} returned invalid payload: expected object.`);
  }
  if (payload.ok !== true) {
    throw new Error(`${label} returned invalid payload: expected ok=true.`);
  }
  if (!Number.isFinite(payload.ts)) {
    throw new Error(`${label} returned invalid payload: expected numeric ts.`);
  }
  if (!Number.isFinite(payload.durationMs)) {
    throw new Error(`${label} returned invalid payload: expected numeric durationMs.`);
  }
  if (typeof payload.defaultAgentId !== "string" || payload.defaultAgentId.trim() === "") {
    throw new Error(`${label} returned invalid payload: expected defaultAgentId.`);
  }
  if (!Array.isArray(payload.agents)) {
    throw new Error(`${label} returned invalid payload: expected agents array.`);
  }
  if (!isRecord(payload.channels)) {
    throw new Error(`${label} returned invalid payload: expected channels object.`);
  }
  if (!Array.isArray(payload.channelOrder)) {
    throw new Error(`${label} returned invalid payload: expected channelOrder array.`);
  }
  if (!isRecord(payload.sessions)) {
    throw new Error(`${label} returned invalid payload: expected sessions object.`);
  }
}

async function smokePlugin(pluginId, pluginDir, requiresConfig, pluginIndex, pluginRoot) {
  if (requiresConfig) {
    console.log(`Runtime smoke skipped for ${pluginId}: plugin requires config`);
    return;
  }
  const entrypoint = process.env.OPENCLAW_ENTRY;
  if (!entrypoint) {
    throw new Error("missing OPENCLAW_ENTRY");
  }
  const manifest = loadManifest(pluginDir, pluginRoot);
  const plan = buildPluginPlan(manifest);
  const port = resolveRuntimeSmokePort(pluginIndex);
  const config = ensureGatewayConfig(
    activateSmokePlugin(readConfig(), pluginId, plan.channels),
    port,
  );
  const env = withManifestChannelActivationEnv(process.env, plan.channels);
  if (plan.speechProviders[0]) {
    const provider = plan.speechProviders[0];
    config.messages = {
      ...config.messages,
      tts: {
        ...config.messages?.tts,
        provider,
        providers: {
          ...config.messages?.tts?.providers,
          [provider]: {
            ...config.messages?.tts?.providers?.[provider],
          },
        },
      },
    };
  }
  writeConfig(config);

  const logPath = `/tmp/openclaw-plugin-runtime-${pluginIndex}-${pluginId}.log`;
  const child = startGateway({
    entrypoint,
    port,
    logPath,
    env,
    skipChannels: plan.channels.length === 0,
  });
  try {
    await waitForReady({ child, port, logPath });
    await assertBaseGatewayProbes({
      entrypoint,
      port,
      env,
      pluginId,
      allowedDegradedReadyzFailures: plan.channels,
    });
    await runManifestProbes(plan, { entrypoint, port, env, pluginId });
    await runWatchdog({ child, logPath, port, entrypoint, env, pluginId });
    console.log(`Runtime smoke passed for ${pluginId}`);
  } catch (error) {
    console.error(tailFile(logPath));
    throw error;
  } finally {
    await stopGateway(child);
  }
}

async function assertBaseGatewayProbes(options) {
  await assertHttpOk(options.port, "/healthz");
  await assertReadyzProbe(options);
  assertGatewayHealthPayload(await retryRpcCall("health", {}, options));
}

async function runManifestProbes(plan, options) {
  for (const channel of plan.channels) {
    const status = await retryRpcCall(
      "channels.status",
      { probe: false, timeoutMs: 2000 },
      options,
    );
    assertChannelVisible(status, channel, options.pluginId);
  }
  if (plan.runtimeSlashAliases.length > 0 && plan.activeInThisProbe) {
    await retryCommandsListWithAliases(plan.runtimeSlashAliases, options);
  } else if (plan.runtimeSlashAliases.length > 0) {
    console.log(
      `Runtime slash command smoke skipped for ${options.pluginId}: plugin is lazy in this probe`,
    );
  }
  if (plan.tools.length > 0 && plan.activeInThisProbe) {
    const catalog = await retryRpcCall("tools.catalog", { includePlugins: true }, options);
    for (const tool of plan.tools) {
      assertToolVisible(catalog, tool);
    }
  } else if (plan.tools.length > 0) {
    console.log(
      `Runtime tool catalog smoke skipped for ${options.pluginId}: plugin is lazy in this probe`,
    );
  }
  if (plan.speechProviders.length > 0) {
    const providers = await retryRpcCall("tts.providers", {}, options);
    const status = await retryRpcCall("tts.status", {}, options);
    const provider = plan.speechProviders[0];
    assertSpeechProviderVisible(providers, provider, "tts.providers");
    assertSpeechProviderVisible(status, provider, "tts.status");
  }
}

function isChannelVisible(payload, channel) {
  const channelMeta = payload.channelMeta;
  const hasMeta = Array.isArray(channelMeta)
    ? channelMeta.some((entry) => entry?.id === channel)
    : Boolean(channelMeta?.[channel]);
  if (hasMeta || payload.channels?.[channel] || payload.channelAccounts?.[channel]) {
    return true;
  }
  return false;
}

export function assertChannelVisible(payload, channel, pluginId) {
  if (isChannelVisible(payload, channel)) {
    return;
  }
  throw new Error(
    `Runtime channel status missing manifest channel ${channel} for ${pluginId}: channels.status did not expose the declared channel`,
  );
}

export function isCommandVisible(payload, alias) {
  const expected = alias.replace(/^\//u, "").toLowerCase();
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  return commands.some((command) => {
    const names = [
      command?.name,
      command?.nativeName,
      ...(Array.isArray(command?.textAliases) ? command.textAliases : []),
    ]
      .filter(isNonEmptyString)
      .map((value) => value.replace(/^\//u, "").toLowerCase());
    return names.includes(expected);
  });
}

function assertCommandVisible(payload, alias) {
  const expected = alias.replace(/^\//u, "").toLowerCase();
  if (!isCommandVisible(payload, alias)) {
    throw new Error(
      `commands.list did not include /${expected}: ${JSON.stringify(payload).slice(0, 2000)}`,
    );
  }
}

async function retryCommandsListWithAliases(aliases, options) {
  const started = Date.now();
  let commands;
  while (Date.now() - started < COMMAND_TIMEOUT_MS) {
    commands = await retryRpcCall("commands.list", { scope: "both", includeArgs: true }, options);
    const missing = aliases.filter((alias) => !isCommandVisible(commands, alias));
    if (missing.length === 0) {
      return commands;
    }
    await delay(500);
  }
  for (const alias of aliases) {
    assertCommandVisible(commands, alias);
  }
  return commands;
}

function assertToolVisible(payload, tool) {
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const found = groups.some((group) =>
    (Array.isArray(group?.tools) ? group.tools : []).some((entry) => entry?.id === tool),
  );
  if (!found) {
    throw new Error(
      `tools.catalog did not include ${tool}: ${JSON.stringify(payload).slice(0, 2000)}`,
    );
  }
}

function assertSpeechProviderVisible(payload, provider, label) {
  const expected = provider.toLowerCase();
  const candidates = [
    ...(Array.isArray(payload.providers) ? payload.providers : []),
    ...(Array.isArray(payload.providerStates) ? payload.providerStates : []),
  ];
  const found = candidates.some((entry) => String(entry?.id ?? "").toLowerCase() === expected);
  if (!found) {
    throw new Error(
      `${label} did not include ${provider}: ${JSON.stringify(payload).slice(0, 2000)}`,
    );
  }
}

async function runWatchdog(options) {
  const readyOffset = findReadyLogOffset(options.logPath);
  await delay(WATCHDOG_MS);
  if (hasChildExited(options.child)) {
    throw new Error(
      `gateway exited after ready for ${options.pluginId}\n${tailFile(options.logPath)}`,
    );
  }
  assertGatewayHealthPayload(
    await retryRpcCall("health", {}, options),
    `${options.pluginId} watchdog health`,
  );
  assertGatewayLogNotTruncated(options.logPath);
  assertNoPostReadyRuntimeDepsWork(options.logPath, readyOffset);
  await assertNoPackageManagerChildren(options.child.pid);
}

export function findReadyLogOffset(logPath) {
  return findFirstNeedleOffset(logPath, READY_OFFSET_LOG_NEEDLES);
}

export function assertGatewayLogNotTruncated(logPath) {
  if (readFileTail(logPath).includes(GATEWAY_LOG_TRUNCATED_NEEDLE)) {
    throw new Error(
      `gateway log exceeded ${String(
        GATEWAY_LOG_CAPTURE_BYTES,
      )} bytes; runtime smoke cannot validate complete post-ready output`,
    );
  }
}

export function assertNoPostReadyRuntimeDepsWork(logPath, readyOffset) {
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return;
  }

  let offset = Math.min(Math.max(0, Math.floor(Number(readyOffset) || 0)), stat.size);
  let carry = "";
  while (offset < stat.size) {
    const { buffer } = readFileChunk(logPath, offset, LOG_SCAN_BYTES);
    if (buffer.length === 0) {
      break;
    }
    const text = carry + buffer.toString("utf8");
    const match = FORBIDDEN_POST_READY_DEPS_WORK.find((pattern) => pattern.test(text));
    if (match) {
      throw new Error(`post-ready runtime dependency work matched ${match}: ${tailText(text)}`);
    }
    carry = text.slice(-256);
    offset += buffer.length;
  }
}

function commandIncludesPackageManager(args) {
  return String(args ?? "")
    .trim()
    .split(/\s+/u)
    .some((token) =>
      PACKAGE_MANAGER_PROCESS_BASENAME.test(
        path.basename(token.replace(/^['"]|['"]$/gu, "")).toLowerCase(),
      ),
    );
}

function parseProcessSnapshot(stdout) {
  const processes = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) {
      continue;
    }
    processes.push({
      args: match[3],
      pid: Number(match[1]),
      ppid: Number(match[2]),
    });
  }
  return processes;
}

export function findPackageManagerDescendants(psOutput, rootPid) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0) {
    return [];
  }

  const childrenByParent = new Map();
  for (const processInfo of parseProcessSnapshot(psOutput)) {
    const list = childrenByParent.get(processInfo.ppid) ?? [];
    list.push(processInfo);
    childrenByParent.set(processInfo.ppid, list);
  }

  const matches = [];
  const pending = [...(childrenByParent.get(root) ?? [])];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || seen.has(current.pid)) {
      continue;
    }
    seen.add(current.pid);
    if (commandIncludesPackageManager(current.args)) {
      matches.push(current);
    }
    pending.push(...(childrenByParent.get(current.pid) ?? []));
  }
  return matches;
}

export async function assertNoPackageManagerChildren(pid) {
  if (!pid || process.platform === "win32") {
    return;
  }
  try {
    const { stdout } = await runCommand("ps", PROCESS_SNAPSHOT_ARGS);
    const packageManagerDescendants = findPackageManagerDescendants(stdout, pid);
    if (packageManagerDescendants.length > 0) {
      const formatted = packageManagerDescendants
        .map((entry) => `${entry.pid} ${entry.args}`)
        .join("\n");
      throw new Error(
        `package manager descendant process still running under gateway ${pid}:\n${formatted}`,
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("Runtime deps child-process watchdog skipped: ps unavailable");
      return;
    }
    throw error;
  }
}

async function smokeTtsGlobalDisable(pluginId, pluginDir, provider, pluginIndex, pluginRoot) {
  const entrypoint = process.env.OPENCLAW_ENTRY;
  if (!entrypoint) {
    throw new Error("missing OPENCLAW_ENTRY");
  }
  const manifest = loadManifest(pluginDir, pluginRoot);
  const plan = buildPluginPlan(manifest);
  const selectedProvider = provider || plan.speechProviders[0];
  if (!selectedProvider) {
    console.log(`Global-disable TTS smoke skipped for ${pluginId}: no speech provider contract`);
    return;
  }
  const port = resolveRuntimeSmokePort(pluginIndex, 1);
  const env = createIsolatedStateEnv(`tts-disabled-${pluginId}`);
  writeConfig(
    ensureGatewayConfig(
      {
        plugins: {
          enabled: false,
        },
        messages: {
          tts: {
            provider: selectedProvider,
          },
        },
      },
      port,
    ),
    env,
  );
  const logPath = `/tmp/openclaw-plugin-runtime-${pluginIndex}-${pluginId}-tts-disabled.log`;
  const child = startGateway({ entrypoint, port, logPath, env, skipChannels: true });
  try {
    await waitForReady({ child, port, logPath });
    await assertBaseGatewayProbes({ entrypoint, port, env });
    const providers = await retryRpcCall("tts.providers", {}, { entrypoint, port, env });
    assertSpeechProviderVisible(providers, selectedProvider, "tts.providers global-disable");
    await runWatchdog({
      child,
      logPath,
      port,
      entrypoint,
      env,
      pluginId: `${pluginId}:tts-disabled`,
    });
    console.log(`Global-disable TTS smoke passed for ${pluginId}/${selectedProvider}`);
  } catch (error) {
    console.error(tailFile(logPath));
    throw error;
  } finally {
    await stopGateway(child);
    cleanupIsolatedStateEnv(env);
  }
}

async function smokeOpenAiTts(pluginIndex) {
  const entrypoint = process.env.OPENCLAW_ENTRY;
  if (!entrypoint) {
    throw new Error("missing OPENCLAW_ENTRY");
  }
  if (!process.env.OPENAI_API_KEY) {
    console.log("OpenAI key-backed TTS smoke skipped: OPENAI_API_KEY is not set");
    return;
  }
  const port = resolveRuntimeSmokePort(pluginIndex, 2);
  const env = createIsolatedStateEnv("tts-openai-live");
  writeConfig(
    ensureGatewayConfig(
      {
        plugins: {
          enabled: true,
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
          },
        },
        messages: {
          tts: {
            provider: "openai",
            providers: {
              openai: {
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              },
            },
          },
        },
      },
      port,
    ),
    env,
  );
  const logPath = `/tmp/openclaw-plugin-runtime-${pluginIndex}-openai-tts-live.log`;
  const child = startGateway({ entrypoint, port, logPath, env, skipChannels: true });
  try {
    await waitForReady({ child, port, logPath });
    await assertBaseGatewayProbes({ entrypoint, port, env });
    const result = await retryRpcCall(
      "tts.convert",
      { text: "ok", provider: "openai" },
      { entrypoint, port, env },
    );
    if (!isNonEmptyString(result.audioPath) || !fs.existsSync(result.audioPath)) {
      throw new Error(`tts.convert did not produce an audio file: ${JSON.stringify(result)}`);
    }
    await runWatchdog({ child, logPath, port, entrypoint, env, pluginId: "openai:tts-live" });
    console.log("OpenAI key-backed TTS smoke passed");
  } catch (error) {
    console.error(tailFile(logPath));
    throw error;
  } finally {
    await stopGateway(child);
    cleanupIsolatedStateEnv(env);
  }
}

export function createIsolatedStateEnv(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  isolatedStateRoots.set(env, root);
  return env;
}

export function cleanupIsolatedStateEnv(env) {
  const root = isolatedStateRoots.get(env);
  if (!root) {
    return;
  }
  isolatedStateRoots.delete(env);
  fs.rmSync(root, { force: true, recursive: true });
}

function tailFile(file) {
  return tailText(readFileTail(file));
}

function tailText(text) {
  return text.split(/\r?\n/u).slice(-120).join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const [command, pluginId, pluginDir, requiresConfigRaw, pluginIndexRaw, pluginRoot, provider] =
    argv;
  const pluginIndex = readNonNegativeInt(pluginIndexRaw, 0, "bundled plugin runtime index");

  if (command === "plugin") {
    await smokePlugin(pluginId, pluginDir, requiresConfigRaw === "1", pluginIndex, pluginRoot);
  } else if (command === "tts-global-disable") {
    await smokeTtsGlobalDisable(pluginId, pluginDir, provider, pluginIndex, pluginRoot);
  } else if (command === "tts-openai-live") {
    await smokeOpenAiTts(pluginIndex);
  } else {
    throw new Error(`Unknown runtime smoke command: ${command || "(missing)"}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
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
