import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

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
const RPC_TIMEOUT_MS = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_RPC_CALL_MS, 60000);
const MAX_RSS_MIB = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB, 2048);

let callGatewayModulePromise;

function readPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
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
  return { command: "pnpm", baseArgs: ["openclaw"], label: "pnpm openclaw" };
}

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-kitchen-sink-rpc-"));
  const home = path.join(root, "home");
  const stateDir = path.join(home, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      HOME: home,
      OPENCLAW_HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_SKIP_PROVIDERS: "0",
      OPENCLAW_KITCHEN_SINK_PERSONALITY:
        process.env.OPENCLAW_KITCHEN_SINK_PERSONALITY || "conformance",
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (status === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal || status}${detail ? `\n${tailText(detail)}` : ""}`,
        ),
      );
    });
  });
}

async function runOpenClaw(runner, args, env, options = {}) {
  return runCommand(runner.command, [...runner.baseArgs, ...args], {
    env,
    timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
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
  const { callGateway } = await loadCallGatewayModule();
  const payload = await callGateway({
    config: readJson(options.env.OPENCLAW_CONFIG_PATH),
    configPath: options.env.OPENCLAW_CONFIG_PATH,
    url: `ws://127.0.0.1:${options.port}`,
    token: TOKEN,
    method,
    params: params ?? {},
    timeoutMs: RPC_TIMEOUT_MS,
    requiredMethods: [method],
  });
  return unwrapRpcPayload(payload);
}

async function loadCallGatewayModule() {
  callGatewayModulePromise ??= import(
    pathToFileURL(path.join(process.cwd(), "src/gateway/call.ts"))
  );
  return callGatewayModulePromise;
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
    text.includes("gateway starting") ||
    text.includes("gateway closed") ||
    text.includes("handshake timeout") ||
    text.includes("GatewayTransportError") ||
    text.includes("ECONNREFUSED") ||
    text.includes("fetch failed")
  );
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
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

function startGateway(runner, port, env, logPath) {
  const log = fs.openSync(logPath, "w");
  const child = childProcess.spawn(
    runner.command,
    [
      ...runner.baseArgs,
      "gateway",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      env,
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

async function waitForGatewayReady(child, port, logPath) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited before ready\n${tailFile(logPath)}`);
    }
    try {
      const readyz = await fetchJson(`http://127.0.0.1:${port}/readyz`);
      if (readyz.ok) {
        return;
      }
      lastError = `/readyz HTTP ${readyz.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes("[gateway] ready")) {
      return;
    }
    await delay(250);
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

function extractPluginCommandNames(payload) {
  const commands = Array.isArray(payload?.commands) ? payload.commands : [];
  const names = [];
  for (const entry of commands) {
    if (entry?.source !== "plugin" && entry?.pluginId !== PLUGIN_ID) {
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

async function sampleProcess(pid) {
  if (!pid || process.platform === "win32") {
    return null;
  }
  try {
    const { stdout } = await runCommand("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], {
      timeoutMs: 5000,
    });
    const [rssKbRaw, cpuRaw] = stdout.trim().split(/\s+/u);
    const rssKb = Number.parseInt(rssKbRaw ?? "", 10);
    const cpuPercent = Number.parseFloat(cpuRaw ?? "");
    if (!Number.isFinite(rssKb)) {
      return null;
    }
    return {
      rssMiB: Math.round((rssKb / 1024) * 10) / 10,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : null,
    };
  } catch {
    return null;
  }
}

function assertResourceCeiling(sample) {
  if (!sample) {
    return;
  }
  if (sample.rssMiB > MAX_RSS_MIB) {
    throw new Error(`gateway RSS exceeded ${MAX_RSS_MIB} MiB: ${sample.rssMiB} MiB`);
  }
}

function assertNoErrorLogs(logPath) {
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const deny = [
    /\buncaught exception\b/iu,
    /\bunhandled rejection\b/iu,
    /\bfatal\b/iu,
    /\bpanic\b/iu,
    /\blevel["']?\s*:\s*["']error["']/iu,
    /\[(?:error|ERROR)\]/u,
  ];
  const allow = [/0 errors?/iu, /expected no diagnostics errors?/iu, /diagnostics errors?:\s*$/iu];
  const findings = log
    .split(/\r?\n/u)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => !allow.some((pattern) => pattern.test(line)))
    .filter(({ line }) => deny.some((pattern) => pattern.test(line)));
  if (findings.length > 0) {
    throw new Error(
      `unexpected error-like gateway logs:\n${findings
        .slice(-20)
        .map(({ line, lineNumber }) => `${logPath}:${lineNumber}: ${line}`)
        .join("\n")}`,
    );
  }
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function main() {
  const runner = resolveOpenClawRunner();
  const port = readPositiveInt(process.env.OPENCLAW_KITCHEN_SINK_RPC_PORT, 19173);
  const { root, env } = makeEnv();
  const logPath = path.join(root, "gateway.log");

  console.log(`Kitchen Sink RPC walk using ${PLUGIN_SPEC} via ${runner.label}`);
  await runOpenClaw(runner, ["plugins", "install", PLUGIN_SPEC], env, { timeoutMs: 240000 });
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

  const child = startGateway(runner, port, env, logPath);
  try {
    await waitForGatewayReady(child, port, logPath);
    const initialSample = await sampleProcess(child.pid);
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
    await retryRpcCall("diagnostics.stability", {}, { runner, port, env });
    const finalSample = await sampleProcess(child.pid);
    assertResourceCeiling(finalSample);
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
        },
        null,
        2,
      ),
    );
    console.log("Kitchen Sink RPC walk passed");
  } catch (error) {
    console.error(tailFile(logPath));
    throw error;
  } finally {
    await stopGateway(child);
  }
}

await main();
