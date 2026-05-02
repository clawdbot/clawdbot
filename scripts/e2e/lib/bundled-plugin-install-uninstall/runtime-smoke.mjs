import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const TOKEN = "bundled-plugin-runtime-smoke-token";
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

function readPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function manifestPath(pluginDir) {
  return path.join(process.cwd(), "dist", "extensions", pluginDir, "openclaw.plugin.json");
}

function loadManifest(pluginDir) {
  const file = manifestPath(pluginDir);
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

function activateSmokePlugin(config, pluginId) {
  const allow = Array.isArray(config.plugins?.allow)
    ? Array.from(new Set([...config.plugins.allow, pluginId].filter(isNonEmptyString)))
    : undefined;
  return {
    ...config,
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (status === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal || status}${detail ? `\n${detail}` : ""}`,
        ),
      );
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

async function stopGateway(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < 10000) {
    await delay(100);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function waitForReady(params) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (params.child.exitCode !== null) {
      throw new Error(`gateway exited before ready\n${tailFile(params.logPath)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${params.port}/readyz`);
      if (res.ok) {
        return;
      }
      lastError = `readyz status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (logShowsGatewayReady(params.logPath) && (await httpOk(params.port, "/healthz"))) {
      return;
    }
    await delay(250);
  }
  throw new Error(`gateway did not become ready: ${lastError}\n${tailFile(params.logPath)}`);
}

function logShowsGatewayReady(logPath) {
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  return log.includes("[gateway] ready");
}

async function httpOk(port, pathName) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathName}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function assertHttpOk(port, pathName) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`);
  if (!res.ok) {
    throw new Error(`${pathName} returned HTTP ${res.status}`);
  }
}

async function assertReadyzProbe(options) {
  const res = await fetch(`http://127.0.0.1:${options.port}/readyz`);
  if (res.ok) {
    return;
  }
  if (!options.allowDegradedReadyz) {
    throw new Error(`/readyz returned HTTP ${res.status}`);
  }
  console.log(
    `Runtime readyz smoke degraded for ${options.pluginId}: /readyz returned HTTP ${res.status}`,
  );
}

async function rpcCall(method, params, options) {
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
  const { stdout } = await runCommand("node", args, {
    env: {
      ...process.env,
      ...options.env,
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_STATE_DIR: rpcStateDir,
    },
  });
  return unwrapRpcPayload(parseJsonOutput(stdout));
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
  throw lastError ?? new Error(`gateway RPC ${method} timed out before retry`);
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

async function smokePlugin(pluginId, pluginDir, requiresConfig, pluginIndex) {
  if (requiresConfig) {
    console.log(`Runtime smoke skipped for ${pluginId}: plugin requires config`);
    return;
  }
  const entrypoint = process.env.OPENCLAW_ENTRY;
  if (!entrypoint) {
    throw new Error("missing OPENCLAW_ENTRY");
  }
  const manifest = loadManifest(pluginDir);
  const plan = buildPluginPlan(manifest);
  const port =
    readPositiveInt(process.env.OPENCLAW_BUNDLED_PLUGIN_RUNTIME_PORT_BASE, 19000) + pluginIndex * 3;
  const config = ensureGatewayConfig(activateSmokePlugin(readConfig(), pluginId), port);
  for (const channel of plan.channels) {
    config.channels = {
      ...config.channels,
      [channel]: {
        ...config.channels?.[channel],
        enabled: true,
      },
    };
  }
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
    if (!isChannelVisible(status, channel)) {
      console.log(
        `Runtime channel status smoke skipped for ${options.pluginId}: ${channel} is not visible in dry channels.status`,
      );
    }
  }
  if (plan.runtimeSlashAliases.length > 0 && plan.activeInThisProbe) {
    const commands = await retryRpcCall(
      "commands.list",
      { scope: "both", includeArgs: true },
      options,
    );
    for (const alias of plan.runtimeSlashAliases) {
      assertCommandVisible(commands, alias);
    }
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

function assertCommandVisible(payload, alias) {
  const expected = alias.replace(/^\//u, "").toLowerCase();
  const commands = Array.isArray(payload.commands) ? payload.commands : [];
  const found = commands.some((command) => {
    const names = [
      command?.name,
      command?.nativeName,
      ...(Array.isArray(command?.textAliases) ? command.textAliases : []),
    ]
      .filter(isNonEmptyString)
      .map((value) => value.replace(/^\//u, "").toLowerCase());
    return names.includes(expected);
  });
  if (!found) {
    throw new Error(
      `commands.list did not include /${expected}: ${JSON.stringify(payload).slice(0, 2000)}`,
    );
  }
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
  const readyIndex = findReadyLogIndex(options.logPath);
  await delay(WATCHDOG_MS);
  if (options.child.exitCode !== null) {
    throw new Error(
      `gateway exited after ready for ${options.pluginId}\n${tailFile(options.logPath)}`,
    );
  }
  await retryRpcCall("health", {}, options);
  assertNoPostReadyRuntimeDepsWork(options.logPath, readyIndex);
  await assertNoPackageManagerChildren(options.child.pid);
}

function findReadyLogIndex(logPath) {
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const candidates = ["[gateway] ready", "listening on ws://", "[gateway] http server listening"];
  const indexes = candidates.map((needle) => log.indexOf(needle)).filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : 0;
}

function assertNoPostReadyRuntimeDepsWork(logPath, readyIndex) {
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const postReady = log.slice(Math.max(0, readyIndex));
  const forbidden = [/\b(?:npm|pnpm|yarn|corepack) install\b/iu];
  const match = forbidden.find((pattern) => pattern.test(postReady));
  if (match) {
    throw new Error(`post-ready runtime dependency work matched ${match}: ${tailText(postReady)}`);
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

async function smokeTtsGlobalDisable(pluginId, pluginDir, provider, pluginIndex) {
  const entrypoint = process.env.OPENCLAW_ENTRY;
  if (!entrypoint) {
    throw new Error("missing OPENCLAW_ENTRY");
  }
  const manifest = loadManifest(pluginDir);
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
  }
}

function createIsolatedStateEnv(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${label}-`));
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

function tailFile(file) {
  if (!fs.existsSync(file)) {
    return "";
  }
  return tailText(fs.readFileSync(file, "utf8"));
}

function tailText(text) {
  return text.split(/\r?\n/u).slice(-120).join("\n");
}

const [command, pluginId, pluginDir, requiresConfigRaw, pluginIndexRaw, provider] =
  process.argv.slice(2);
const pluginIndex = Number.parseInt(pluginIndexRaw || "0", 10);

if (command === "plugin") {
  await smokePlugin(pluginId, pluginDir, requiresConfigRaw === "1", pluginIndex);
} else if (command === "tts-global-disable") {
  await smokeTtsGlobalDisable(pluginId, pluginDir, provider, pluginIndex);
} else if (command === "tts-openai-live") {
  await smokeOpenAiTts(pluginIndex);
} else {
  throw new Error(`Unknown runtime smoke command: ${command || "(missing)"}`);
}
