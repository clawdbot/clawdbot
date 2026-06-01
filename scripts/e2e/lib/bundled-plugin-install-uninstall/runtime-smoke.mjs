import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TOKEN = "bundled-plugin-runtime-smoke-token";
const OUTPUT_CAPTURE_CHARS = readPositiveInt(
  process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_OUTPUT_CHARS,
  1024 * 1024,
);
const LOG_SCAN_BYTES = readPositiveInt(
  process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_LOG_SCAN_BYTES,
  256 * 1024,
);
const WATCHDOG_MS = readPositiveInt(process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_WATCHDOG_MS, 1000);
const READY_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_READY_MS,
  900000,
);
const RPC_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_MS, 60000);
const RPC_READY_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_RPC_READY_MS,
  210000,
);
const COMMAND_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_COMMAND_MS,
  120000,
);
const HTTP_PROBE_TIMEOUT_MS = readPositiveInt(
  process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_HTTP_MS,
  5000,
);
const GATEWAY_READY_LOG_NEEDLE = Buffer.from("[gateway] ready");
const READY_OFFSET_LOG_NEEDLES = [
  GATEWAY_READY_LOG_NEEDLE,
  Buffer.from("listening on ws://"),
  Buffer.from("[gateway] http server listening"),
];
const FORBIDDEN_POST_READY_DEPS_WORK = [/\b(?:npm|pnpm|yarn|corepack) install\b/iu];
const isolatedStateRoots = new WeakMap();

function readPositiveInt(raw, fallback) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
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
          child.kill("SIGKILL");
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

function startGateway(params) {
  const log = fs.openSync(params.logPath, "w");
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
      stdio: ["ignore", log, log],
      detached: false,
    },
  );
  fs.closeSync(log);
  return child;
}

export function hasChildExited(child) {
  return child.exitCode !== null || (child.signalCode ?? null) !== null;
}

export async function stopGateway(child) {
  if (!child || hasChildExited(child)) {
    return;
  }
  child.kill("SIGTERM");
  const started = Date.now();
  while (!hasChildExited(child) && Date.now() - started < 10000) {
    await delay(100);
  }
  if (!hasChildExited(child)) {
    child.kill("SIGKILL");
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
  const { timeoutMs = HTTP_PROBE_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const clearProbeTimer = timeoutMs
    ? setTimeout(() => {
        controller.abort();
      }, timeoutMs)
    : undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
      signal: controller.signal,
    });
    const status = { ok: res.ok, status: res.status };
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
    await delay(500);
  }
  throw toLintErrorObject(
    lastError ?? new Error(`${pathName} did not return HTTP 200`),
    "Non-Error thrown",
  );
}

async function assertReadyzProbe(options) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < RPC_READY_TIMEOUT_MS) {
    try {
      const res = await fetchHttpProbeStatus(options.port, "/readyz");
      if (res.ok) {
        return;
      }
      if (options.allowDegradedReadyz) {
        console.log(
          `Runtime readyz smoke degraded for ${options.pluginId}: /readyz returned HTTP ${res.status}`,
        );
        return;
      }
      lastError = new Error(`/readyz returned HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
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
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonStart = trimmed.indexOf("{");
    if (jsonStart >= 0) {
      try {
        return JSON.parse(trimmed.slice(jsonStart));
      } catch {
        // Fall through to the line-oriented fallback below.
      }
    }
    const jsonLine = trimmed
      .split(/\r?\n/u)
      .toReversed()
      .find((line) => line.trim().startsWith("{"));
    if (!jsonLine) {
      throw new Error(`gateway call JSON output was not parseable:\n${trimmed}`);
    }
    return JSON.parse(jsonLine);
  }
}

function unwrapRpcPayload(raw) {
  if (raw?.ok === false) {
    throw new Error(`gateway RPC failed: ${JSON.stringify(raw.error ?? raw)}`);
  }
  return raw?.result ?? raw?.payload ?? raw?.data ?? raw;
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
  const port =
    readPositiveInt(process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE, 19000) + pluginIndex * 3;
  const config = ensureGatewayConfig(
    activateSmokePlugin(readConfig(), pluginId, plan.channels),
    port,
  );
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
    env: process.env,
    skipChannels: plan.channels.length === 0,
  });
  try {
    await waitForReady({ child, port, logPath });
    await assertBaseGatewayProbes({
      entrypoint,
      port,
      env: process.env,
      pluginId,
      allowDegradedReadyz: plan.channels.length > 0,
    });
    await runManifestProbes(plan, { entrypoint, port, env: process.env, pluginId });
    await runWatchdog({ child, logPath, port, entrypoint, env: process.env, pluginId });
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
  await retryRpcCall("health", {}, options);
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
  await retryRpcCall("health", {}, options);
  assertNoPostReadyRuntimeDepsWork(options.logPath, readyOffset);
  await assertNoPackageManagerChildren(options.child.pid);
}

export function findReadyLogOffset(logPath) {
  return findFirstNeedleOffset(logPath, READY_OFFSET_LOG_NEEDLES);
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

async function assertNoPackageManagerChildren(pid) {
  if (!pid || process.platform === "win32") {
    return;
  }
  try {
    const { stdout } = await runCommand("pgrep", [
      "-P",
      String(pid),
      "-af",
      "npm|pnpm|yarn|corepack",
    ]);
    if (stdout.trim()) {
      throw new Error(
        `package manager child process still running under gateway ${pid}:\n${stdout}`,
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("Runtime deps child-process watchdog skipped: pgrep unavailable");
      return;
    }
    if (error instanceof Error && error.message.includes("failed with 1")) {
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
  const port =
    readPositiveInt(process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE, 19000) +
    pluginIndex * 3 +
    1;
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
  const port =
    readPositiveInt(process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE, 19000) +
    pluginIndex * 3 +
    2;
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

export async function main(argv = process.argv.slice(2)) {
  const [command, pluginId, pluginDir, requiresConfigRaw, pluginIndexRaw, pluginRoot, provider] =
    argv;
  const pluginIndex = Number.parseInt(pluginIndexRaw || "0", 10);

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
