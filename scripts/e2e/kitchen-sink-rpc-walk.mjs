import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const READY_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_RPC_READY_MS, 240000);
const COMMAND_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS,
  180000,
);
const INSTALL_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS,
  Math.max(COMMAND_TIMEOUT_MS, 600000),
);
const RPC_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_RPC_CALL_MS, 60000);
const FETCH_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS, 10000);
const FETCH_BODY_MAX_BYTES = readPositiveInt(
  process.env.OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES,
  1024 * 1024,
);
const MAX_RSS_MIB = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB, 2048);
const GATEWAY_TEARDOWN_GRACE_MS = 10000;
const GATEWAY_TEARDOWN_KILL_GRACE_MS = 2000;
const OUTPUT_CAPTURE_CHARS = readPositiveInt(
  process.env.OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS,
  1024 * 1024,
);
const DEFAULT_PORT = 19000 + Math.floor(Math.random() * 1000);
const LOG_SCAN_CHUNK_BYTES = 64 * 1024;
const LOG_SCAN_MAX_LINE_CHARS = 16 * 1024;
const LOG_TAIL_BYTES = 256 * 1024;
const ERROR_LOG_DENY_PATTERNS = [
  /\buncaught exception\b/iu,
  /\bunhandled rejection\b/iu,
  /\bfatal\b/iu,
  /\bpanic\b/iu,
  /\blevel["']?\s*:\s*["']error["']/iu,
  /\[(?:error|ERROR)\]/u,
];
const ERROR_LOG_ALLOW_PATTERNS = [
  /0 errors?/iu,
  /expected no diagnostics errors?/iu,
  /diagnostics errors?:\s*$/iu,
];

let callGatewayModulePromise;

export function readPositiveInt(raw, fallback) {
  const text = String(raw || "").trim();
  if (!/^\d+$/u.test(text)) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

export function appendBoundedOutput(buffer, chunk, maxChars = OUTPUT_CAPTURE_CHARS) {
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
  return new Promise((resolve, reject) => {
    const { timeoutKillGraceMs = 2000, timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
      detached: spawnOptions.detached ?? process.platform !== "win32",
    });
    let stdout = { text: "", truncatedChars: 0 };
    let stderr = { text: "", truncatedChars: 0 };
    let timedOut = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), timeoutKillGraceMs);
      forceKillTimer.unref();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
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
      const failure = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `failed with ${signal || status}`;
      reject(
        new Error(
          `${command} ${args.join(" ")} ${failure}${detail ? `\n${tailText(detail)}` : ""}`,
        ),
      );
    });
  });
}

function signalProcessGroup(child, signal) {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
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
  const command = await resolveOpenClawCommand(runner, args, env, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return runCommand(command.command, command.args, {
    ...command.options,
    env,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
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

function parseJsonOutput(stdout) {
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

function extractBalancedJsonObjects(text) {
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
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

function unwrapRpcPayload(raw) {
  if (raw?.ok === false) {
    throw new Error(`gateway RPC failed: ${JSON.stringify(raw.error ?? raw)}`);
  }
  return raw?.result ?? raw?.payload ?? raw?.data ?? raw;
}

async function rpcCall(method, params, options) {
  const module = await loadCallGatewayModule(options.runner);
  const payload = module
    ? await module.callGateway({
        config: readJson(options.env.OPENCLAW_CONFIG_PATH),
        configPath: options.env.OPENCLAW_CONFIG_PATH,
        url: `ws://127.0.0.1:${options.port}`,
        token: TOKEN,
        method,
        params: params ?? {},
        timeoutMs: RPC_TIMEOUT_MS,
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
  const { stdout } = await runOpenClaw(
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
      String(RPC_TIMEOUT_MS),
      "--json",
      "--params",
      JSON.stringify(params ?? {}),
    ],
    options.env,
    { timeoutMs: RPC_TIMEOUT_MS + 30000 },
  );
  return parseJsonOutput(stdout);
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
  let lastError;
  while (Date.now() - started < READY_TIMEOUT_MS) {
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
  throw lastError ?? new Error(`gateway RPC ${method} timed out before retry`);
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
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = Math.max(1, options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBodyBytes = Math.max(1, options.maxBodyBytes ?? FETCH_BODY_MAX_BYTES);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error(`fetch ${url} timed out after ${timeoutMs}ms`), {
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
        (options.fetchImpl ?? fetch)(url, { signal: controller.signal }),
        timeoutPromise,
      ]);
      const text = await Promise.race([
        readBoundedResponseText(response, maxBodyBytes),
        timeoutPromise,
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
      await delay(options.retryDelayMs ?? 250);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
  throw lastError ?? new Error(`fetch ${url} failed`);
}

export async function readBoundedResponseText(response, byteLimit = FETCH_BODY_MAX_BYTES) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength) {
    const parsedContentLength = Number(contentLength);
    if (Number.isFinite(parsedContentLength) && parsedContentLength > byteLimit) {
      await response.body?.cancel?.().catch(() => undefined);
      throw createFetchBodyTooLargeError(byteLimit);
    }
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > byteLimit) {
      throw createFetchBodyTooLargeError(byteLimit);
    }
    return text;
  }
  const chunks = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > byteLimit) {
      await reader.cancel().catch(() => undefined);
      throw createFetchBodyTooLargeError(byteLimit);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function createFetchBodyTooLargeError(byteLimit) {
  return Object.assign(new Error(`fetch response body exceeded ${byteLimit} bytes`), {
    code: "ETOOBIG",
  });
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
  if (!child || hasChildExited(child)) {
    return;
  }
  const teardownGraceMs = Math.max(0, options.teardownGraceMs ?? GATEWAY_TEARDOWN_GRACE_MS);
  const killGraceMs = Math.max(0, options.killGraceMs ?? GATEWAY_TEARDOWN_KILL_GRACE_MS);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const waitForExit = async (ms) =>
    hasChildExited(child)
      ? true
      : await Promise.race([exited.then(() => true), delay(ms).then(() => false)]);

  signalGateway(child, "SIGTERM");
  if (await waitForExit(teardownGraceMs)) {
    return;
  }
  signalGateway(child, "SIGKILL");
  if (await waitForExit(killGraceMs)) {
    return;
  }
  releaseUnsettledGatewayChild(child);
}

export function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function releaseUnsettledGatewayChild(child) {
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
}

function signalGateway(child, signal) {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
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
  const started = Date.now();
  let lastError = "";
  const timeoutMs = Math.max(1, options.timeoutMs ?? READY_TIMEOUT_MS);
  const pollDelayMs = Math.max(1, options.pollDelayMs ?? 250);
  const logReportedReady = createGatewayReadyLogScanner(logPath);
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
    try {
      const readyz = await fetchJson(`http://127.0.0.1:${port}/readyz`, {
        attempts: 1,
        fetchImpl: options.fetchImpl,
        timeoutMs: Math.min(FETCH_TIMEOUT_MS, remainingMs),
      });
      if (readyz.ok) {
        return;
      }
      lastError = `/readyz HTTP ${readyz.status}`;
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

function valuesForKey(value, key) {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => valuesForKey(entry, key));
  }
  const values = [];
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) {
      values.push(entryValue);
    }
    values.push(...valuesForKey(entryValue, key));
  }
  return values;
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

function extractProviderIds(payload) {
  return valuesForKey(payload, "id").filter(isNonEmptyString);
}

function assertIncludesAny(actual, expected, label) {
  if (!expected.some((value) => actual.includes(value))) {
    throw new Error(`${label} missing one of ${expected.join(", ")}: ${JSON.stringify(actual)}`);
  }
}

function assertIncludesAll(actual, expected, label) {
  const missing = expected.filter((value) => !actual.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label} missing ${missing.join(", ")}: ${JSON.stringify(actual)}`);
  }
}

function assertChannelAccountRunning(payload) {
  const accounts = Array.isArray(payload?.channelAccounts?.[CHANNEL_ID])
    ? payload.channelAccounts[CHANNEL_ID]
    : [];
  const account = accounts.find((entry) => entry?.accountId === CHANNEL_ACCOUNT_ID) ?? accounts[0];
  if (!account?.running || !account?.configured) {
    throw new Error(`Kitchen Sink channel is not running+configured: ${JSON.stringify(payload)}`);
  }
  return account;
}

function assertToolInvokeResult(payload) {
  if (payload?.ok !== true || payload?.source !== "plugin") {
    throw new Error(`Kitchen Sink tool invoke failed: ${JSON.stringify(payload)}`);
  }
  const text = JSON.stringify(payload.output ?? payload);
  if (!text.includes("Kitchen Sink image fixture")) {
    throw new Error(`Kitchen Sink tool output missed expected fixture: ${text.slice(0, 1000)}`);
  }
}

export function assertDiagnosticStabilityClean(payload) {
  const problems = [];
  if (!payload || typeof payload !== "object") {
    throw new Error(`diagnostics.stability returned invalid payload: ${JSON.stringify(payload)}`);
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
        JSON.stringify(payload, null, 2),
      )}`,
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
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], {
      timeoutMs: 5000,
    });
    const rows = parsePosixProcessRows(stdout);
    const selected = rows.find((row) => row.processId === safePid);
    if (!selected) {
      return null;
    }
    return formatPosixProcessTreeSample(selected, collectPosixProcessTree(rows, safePid));
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
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], {
      timeoutMs: 5000,
    });
    const rows = parsePosixProcessRows(stdout);
    const descendants = collectPosixProcessTree(rows, safePid).filter(
      (row) => row.processId !== safePid,
    );
    const commandMatches = descendants.filter((row) =>
      commandLineNeedles.every((needle) =>
        row.command.toLowerCase().includes(needle.toLowerCase()),
      ),
    );
    const gatewayTitleMatches = descendants.filter((row) =>
      row.command.toLowerCase().includes("openclaw-gateway"),
    );
    const selected = selectPeakRssProcess(
      commandMatches.length > 0
        ? commandMatches
        : gatewayTitleMatches.length > 0
          ? gatewayTitleMatches
          : descendants,
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
  return stdout
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.*)$/u);
      if (!match) {
        return null;
      }
      const [, pidRaw, ppidRaw, rssKbRaw, cpuRaw, command] = match;
      const processId = Number.parseInt(pidRaw, 10);
      const parentProcessId = Number.parseInt(ppidRaw, 10);
      const rssKb = Number.parseInt(rssKbRaw, 10);
      const cpuPercent = Number.parseFloat(cpuRaw);
      if (
        !Number.isInteger(processId) ||
        !Number.isInteger(parentProcessId) ||
        !Number.isFinite(rssKb)
      ) {
        return null;
      }
      return {
        processId,
        parentProcessId,
        rssKb,
        cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
        command: command ?? "",
      };
    })
    .filter(Boolean);
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
  while (pending.length > 0) {
    const nextPid = pending.shift();
    for (const child of byParent.get(nextPid) ?? []) {
      collected.push(child);
      pending.push(child.processId);
    }
  }
  return collected;
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
      "tasklist.exe",
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
    const [, processIdRaw, , , memoryRaw] = parseTasklistCsvLine(line);
    const processId = Number.parseInt(processIdRaw ?? "", 10);
    const memoryKiB = Number.parseInt((memoryRaw ?? "").replace(/[^\d]/gu, ""), 10);
    if (!Number.isFinite(memoryKiB)) {
      return null;
    }
    return {
      rssMiB: Math.round((memoryKiB / 1024) * 10) / 10,
      cpuPercent: null,
      cpuSeconds: null,
      processId: Number.isFinite(processId) ? processId : safePid,
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
    const { stdout } = await run("netstat.exe", ["-ano", "-p", "tcp"], { timeoutMs: 15000 });
    const pid = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.includes(`:${safePort}`) && /\bLISTENING\b/iu.test(line))
      .map((line) => Number.parseInt(line.split(/\s+/u).at(-1) ?? "", 10))
      .find((candidate) => Number.isInteger(candidate) && candidate > 0);
    if (!pid) {
      return null;
    }
    return (await sampleWindowsProcess(pid, run)) ?? sampleWindowsPidWithTasklist(pid, run);
  } catch {
    return null;
  }
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
  for (const powershell of ["powershell.exe", "powershell"]) {
    try {
      const { stdout } = await run(
        powershell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { timeoutMs: 15000 },
      );
      const [workingSetBytesRaw, cpuSecondsRaw, processIdRaw, aggregateWorkingSetBytesRaw] = stdout
        .trim()
        .split(/\s+/u);
      const workingSetBytes = Number.parseInt(workingSetBytesRaw ?? "", 10);
      const aggregateWorkingSetBytes = Number.parseInt(
        aggregateWorkingSetBytesRaw ?? workingSetBytesRaw ?? "",
        10,
      );
      const cpuSeconds = Number.parseFloat(cpuSecondsRaw ?? "");
      const processId = Number.parseInt(processIdRaw ?? "", 10);
      if (!Number.isFinite(workingSetBytes)) {
        return null;
      }
      return {
        rssMiB: Math.round((workingSetBytes / 1024 / 1024) * 10) / 10,
        aggregateRssMiB: Number.isFinite(aggregateWorkingSetBytes)
          ? Math.round((aggregateWorkingSetBytes / 1024 / 1024) * 10) / 10
          : Math.round((workingSetBytes / 1024 / 1024) * 10) / 10,
        cpuPercent: null,
        cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : null,
        processId: Number.isFinite(processId) ? processId : safePid,
      };
    } catch {
      // Try the next Windows PowerShell command name.
    }
  }
  return null;
}

export function assertResourceCeiling(sample) {
  if (!sample) {
    throw new Error("gateway RSS sample was not captured");
  }
  if (sample.rssMiB > MAX_RSS_MIB) {
    throw new Error(`gateway RSS exceeded ${MAX_RSS_MIB} MiB: ${sample.rssMiB} MiB`);
  }
  if ((sample.aggregateRssMiB ?? sample.rssMiB) > MAX_RSS_MIB) {
    throw new Error(
      `gateway aggregate RSS exceeded ${MAX_RSS_MIB} MiB: ${sample.aggregateRssMiB} MiB`,
    );
  }
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
  let runner = resolveOpenClawRunner();
  const port = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_RPC_PORT, DEFAULT_PORT);
  const { root, env } = makeEnv();
  const logPath = path.join(root, "gateway.log");
  const keepTmp = process.env.OPENCLAW_KITCHEN_SINK_KEEP_TMP === "1";
  let failed = false;
  let child;

  const processSamples = [];
  let sampleInFlight = null;
  let sampleTimer;
  try {
    console.log(`Kitchen Sink RPC walk using ${PLUGIN_SPEC} via ${runner.label}`);
    await runOpenClaw(runner, ["plugins", "install", PLUGIN_SPEC], env, {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    runner = resolveOpenClawRunner();
    console.log(`Kitchen Sink RPC runtime runner: ${runner.label}`);
    configureKitchenSink(env, port);
    await runOpenClaw(runner, ["plugins", "enable", PLUGIN_ID], env, { timeoutMs: 60000 });
    const inspect = parseJsonOutput(
      (await runOpenClaw(runner, ["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"], env))
        .stdout,
    );
    if (inspect?.plugin?.status !== "loaded") {
      throw new Error(`Kitchen Sink plugin did not inspect as loaded: ${JSON.stringify(inspect)}`);
    }
    const inspectPlugin = inspect.plugin ?? {};
    const inspectProviders = [
      ...(Array.isArray(inspectPlugin.providerIds) ? inspectPlugin.providerIds : []),
      ...(Array.isArray(inspectPlugin.providers) ? inspectPlugin.providers : []),
    ];
    assertIncludesAny(inspectProviders, EXPECTED_PROVIDERS, "plugins inspect providers");

    child = await startGateway(runner, port, env, logPath);
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
      throw new Error(`/healthz did not report live: ${JSON.stringify(healthz)}`);
    }
    if (!readyz.ok || readyz.body?.ready !== true) {
      throw new Error(`/readyz did not report ready: ${JSON.stringify(readyz)}`);
    }

    await retryRpcCall("health", {}, { runner, port, env });
    await retryRpcCall("status", {}, { runner, port, env });
    const channelStatus = await retryRpcCall(
      "channels.status",
      { probe: true, timeoutMs: 10000 },
      { runner, port, env },
    );
    const channelAccount = assertChannelAccountRunning(channelStatus);

    const commands = await retryRpcCall(
      "commands.list",
      { agentId: "main", scope: "text" },
      { runner, port, env },
    );
    const commandNames = extractPluginCommandNames(commands);
    assertIncludesAll(commandNames, EXPECTED_COMMANDS, "commands.list plugin commands");

    const catalog = await retryRpcCall(
      "tools.catalog",
      { agentId: "main", includePlugins: true },
      { runner, port, env },
    );
    const catalogTools = extractToolEntries(catalog);
    const catalogToolIds = catalogTools.map((entry) => entry?.id).filter(isNonEmptyString);
    assertIncludesAny(catalogToolIds, EXPECTED_TOOLS, "tools.catalog plugin tools");
    const pluginTool = catalogTools.find((entry) => EXPECTED_TOOLS.includes(entry?.id));
    if (pluginTool?.source !== "plugin" || pluginTool?.pluginId !== PLUGIN_ID) {
      throw new Error(`tools.catalog plugin provenance missing: ${JSON.stringify(pluginTool)}`);
    }

    const createdSession = await retryRpcCall(
      "sessions.create",
      { key: SESSION_KEY, agentId: "main", label: "kitchen-sink-rpc" },
      { runner, port, env },
    );
    const effective = await retryRpcCall(
      "tools.effective",
      { sessionKey: createdSession.key, agentId: "main" },
      { runner, port, env },
    );
    const effectiveToolIds = extractToolEntries(effective).map((entry) => entry?.id);
    assertIncludesAny(effectiveToolIds, EXPECTED_TOOLS, "tools.effective plugin tools");

    const invoked = await retryRpcCall(
      "tools.invoke",
      {
        name: "kitchen_sink_search",
        args: { query: "kitchen sink rpc walk" },
        sessionKey: createdSession.key,
        agentId: "main",
        idempotencyKey: "kitchen-sink-rpc-search",
      },
      { runner, port, env },
    );
    assertToolInvokeResult(invoked);

    const ttsProviders = await retryRpcCall("tts.providers", {}, { runner, port, env });
    const ttsStatus = await retryRpcCall("tts.status", {}, { runner, port, env });
    assertIncludesAny(extractProviderIds(ttsProviders), EXPECTED_SPEECH_PROVIDERS, "tts.providers");
    assertIncludesAny(extractProviderIds(ttsStatus), EXPECTED_SPEECH_PROVIDERS, "tts.status");

    const uiDescriptors = await retryRpcCall("plugins.uiDescriptors", {}, { runner, port, env });
    if (!uiDescriptors || typeof uiDescriptors !== "object") {
      throw new Error(
        `plugins.uiDescriptors returned invalid payload: ${JSON.stringify(uiDescriptors)}`,
      );
    }
    const stability = await retryRpcCall("diagnostics.stability", {}, { runner, port, env });
    assertDiagnosticStabilityClean(stability);
    await sampleInFlight?.catch(() => {});
    const finalSample = await sampleGateway();
    assertResourceCeiling(finalSample);
    const peakSample = summarizeProcessSamples(processSamples);
    assertResourceCeiling(peakSample);
    assertNoErrorLogs(logPath);

    console.log(
      JSON.stringify(
        {
          ok: true,
          pluginId: PLUGIN_ID,
          commands: commandNames,
          catalogTools: catalogToolIds.filter((id) => EXPECTED_TOOLS.includes(id)),
          channelAccount,
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
      await cleanupKitchenSinkEnv(root);
    } else if (failed || keepTmp) {
      console.error(`Kitchen Sink RPC temp root preserved: ${root}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
