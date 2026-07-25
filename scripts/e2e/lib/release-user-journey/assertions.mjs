// Assertions for release user-journey E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import { readBoundedResponseText as readBoundedResponseTextWithLimit } from "../bounded-response-text.mjs";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../fixtures/mock-openai-config.mjs";
import { readPluginInstallRecords } from "../plugin-index-sqlite.mjs";
import {
  ERROR_DETAIL_TAIL_BYTES,
  fileContainsText,
  readJson,
} from "../release-assertion-files.mjs";
import { readTextFileTail } from "../text-file-utils.mjs";

function clickClackHttpTimeoutMs() {
  return readPositiveInt(
    process.env.OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS,
    5000,
    "OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS",
  );
}

function clickClackHttpBodyMaxBytes() {
  return readPositiveInt(
    process.env.OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES,
    1024 * 1024,
    "OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES",
  );
}

function readPositiveInt(raw, fallback, label) {
  const text = String(raw ?? "").trim();
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

async function withClickClackFixtureResponse(url, init, consume, options = {}) {
  const timeoutMs = options.timeoutMs ?? clickClackHttpTimeoutMs();
  const controller = new AbortController();
  const timeoutError = new Error(`${url} timed out after ${timeoutMs}ms`);
  let timer;
  let response;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    response = await Promise.race([
      fetch(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return await consume(response, { timeoutPromise });
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel?.().catch(() => undefined);
  }
}

async function readBoundedResponseText(
  response,
  label,
  byteLimit = clickClackHttpBodyMaxBytes(),
  options = {},
) {
  return await readBoundedResponseTextWithLimit(response, label, byteLimit, options.timeoutPromise);
}

async function readBoundedResponseJson(response, label, options = {}) {
  return JSON.parse(await readBoundedResponseText(response, label, undefined, options));
}

function resolveHomePath(value) {
  if (value === "~") {
    return process.env.HOME;
  }
  if (value?.startsWith("~/") || value?.startsWith("~\\")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function comparablePath(value) {
  const resolved = path.resolve(resolveHomePath(value));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH ??
    path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json")
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

function installRecords() {
  return readPluginInstallRecords({ configPath: configPath() });
}

function assertOnboard() {
  const home = process.argv[3];
  const stateDir = path.join(home, ".openclaw");
  const authPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  assert(fs.existsSync(configPath()), "onboard did not write openclaw.json");
  const stateRaw =
    fs.readFileSync(configPath(), "utf8") +
    (fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : "");
  assert(
    !stateRaw.includes("sk-openclaw-release-user-journey"),
    "onboard persisted raw OpenAI key",
  );
}

function configureMockModel() {
  const mockPort = parseMockOpenAiPort(process.argv[3]);
  const cfg = readJson(configPath());
  applyMockOpenAiModelConfig(cfg, { mockPort });
  writeConfig(cfg);
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const outputPath = process.argv[4];
  const requestLogPath = process.argv[5];
  assertAgentReplyContainsMarker(marker, outputPath);
  assertOpenAiRequestLogUsed(requestLogPath);
}

function assertFileContains() {
  const file = process.argv[3];
  const needle = process.argv[4];
  assert(
    fileContainsText(file, needle),
    `${file} did not contain ${needle}. Output tail: ${readTextFileTail(file, ERROR_DETAIL_TAIL_BYTES)}`,
  );
}

function rememberPluginInstallPath() {
  const pluginId = process.argv[3];
  const installPathFile = process.argv[4];
  const sourcePathFile = process.argv[5];
  const expectedSourcePath = process.argv[6];
  assert(pluginId, "missing plugin id");
  assert(installPathFile, "missing install path file");
  const record = installRecords()[pluginId];
  assert(record, `missing install record for ${pluginId}`);
  const installPath = resolveHomePath(record.installPath);
  assert(installPath, `install path missing for ${pluginId}`);
  assert(
    fs.existsSync(installPath),
    `install path missing on disk for ${pluginId}: ${installPath}`,
  );
  if (expectedSourcePath && record.sourcePath) {
    assert(
      pathsEqual(record.sourcePath, expectedSourcePath),
      `unexpected source path for ${pluginId}: ${record.sourcePath}, expected ${expectedSourcePath}`,
    );
  }
  fs.writeFileSync(installPathFile, installPath, "utf8");
  if (sourcePathFile && (expectedSourcePath || record.sourcePath)) {
    fs.writeFileSync(
      sourcePathFile,
      expectedSourcePath || resolveHomePath(record.sourcePath),
      "utf8",
    );
  }
}

function assertPluginUninstalled() {
  const pluginId = process.argv[3];
  const installPathFile = process.argv[4];
  const sourcePathFile = process.argv[5];
  const cfg = readJson(configPath());
  const records = installRecords();
  assert(!records[pluginId], `install record still present for ${pluginId}`);
  assert(!cfg.plugins?.entries?.[pluginId], `plugin config entry still present for ${pluginId}`);
  assert(!(cfg.plugins?.allow ?? []).includes(pluginId), `allowlist still contains ${pluginId}`);
  assert(!(cfg.plugins?.deny ?? []).includes(pluginId), `denylist still contains ${pluginId}`);
  if (!installPathFile) {
    return;
  }
  const installPath = fs.readFileSync(installPathFile, "utf8").trim();
  const sourcePath =
    sourcePathFile && fs.existsSync(sourcePathFile)
      ? fs.readFileSync(sourcePathFile, "utf8").trim()
      : "";
  if (sourcePath) {
    assert(
      fs.existsSync(sourcePath),
      `source path was deleted during uninstall for ${pluginId}: ${sourcePath}`,
    );
  }
  const installPathIsSourcePath = sourcePath ? pathsEqual(installPath, sourcePath) : false;
  assert(
    installPathIsSourcePath || !fs.existsSync(installPath),
    `managed plugin directory still present: ${installPath}`,
  );
}

function configureClickClack() {
  const baseUrl = process.argv[3];
  const cfg = readJson(configPath());
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
    entries: {
      ...cfg.plugins?.entries,
      clickclack: {
        ...cfg.plugins?.entries?.clickclack,
        enabled: true,
        llm: {
          ...cfg.plugins?.entries?.clickclack?.llm,
          allowAgentIdOverride: true,
          allowModelOverride: true,
          allowedModels: ["openai/gpt-5.6-luna"],
        },
      },
    },
  };
  cfg.channels = {
    ...cfg.channels,
    clickclack: {
      ...cfg.channels?.clickclack,
      enabled: true,
      baseUrl,
      token: { source: "env", provider: "default", id: "CLICKCLACK_BOT_TOKEN" },
      workspace: "release",
      defaultTo: "channel:general",
      replyMode: "model",
      model: "openai/gpt-5.6-luna",
      reconnectMs: 250,
    },
  };
  writeConfig(cfg);
}

function assertChannelStatus() {
  const channel = process.argv[3];
  const statusPath = process.argv[4];
  const status = readJson(statusPath);
  const configured = Array.isArray(status.configuredChannels) ? status.configuredChannels : [];
  const liveStatus = status.channels?.[channel];
  assert(
    configured.includes(channel) || liveStatus?.ok === true,
    `${channel} missing from channels status: ${JSON.stringify(status)}`,
  );
}

async function postClickClackInbound() {
  const baseUrl = process.argv[3];
  const body = process.argv[4];
  await withClickClackFixtureResponse(
    `${baseUrl}/fixture/inbound`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
    async (response, options) => {
      const text = response.ok
        ? ""
        : await readBoundedResponseText(response, "ClickClack inbound", undefined, options);
      assert(response.ok, `fixture inbound failed: ${response.status} ${text}`);
    },
  );
}

async function waitClickClackSocket() {
  const baseUrl = process.argv[3];
  const timeoutSeconds = readPositiveInt(
    process.argv[4],
    30,
    "ClickClack websocket timeout seconds",
  );
  await waitForClickClackSocket({ baseUrl, timeoutMs: timeoutSeconds * 1000 });
}

export async function waitForClickClackSocket({ baseUrl, timeoutMs, pollIntervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const state = await withClickClackFixtureResponse(
      `${baseUrl}/fixture/state`,
      {},
      async (response, options) =>
        response.ok
          ? await readBoundedResponseJson(response, "ClickClack fixture state", options)
          : undefined,
      {
        timeoutMs: Math.min(clickClackHttpTimeoutMs(), remainingMs),
      },
    ).catch(() => undefined);
    if (state) {
      if (Number(state.socketCount ?? 0) > 0) {
        return;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    });
  }
  throw new Error(`Timed out waiting for ClickClack websocket connection at ${baseUrl}`);
}

function assertClickClackState() {
  const mode = process.argv[3];
  const statePath = process.argv[4];
  const needle = process.argv[5];
  const state = readJson(statePath);
  const haystack = JSON.stringify(mode === "outbound" ? state.outboundMessages : state);
  assert(haystack.includes(needle), `ClickClack state did not contain ${needle}: ${haystack}`);
}

async function waitClickClackReply() {
  const statePath = process.argv[3];
  const marker = process.argv[4];
  const timeoutSeconds = readPositiveInt(process.argv[5], 30, "ClickClack reply timeout seconds");
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath)) {
      const state = readJson(statePath);
      if (JSON.stringify(state.threadReplies ?? []).includes(marker)) {
        return;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  const state = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "<missing>";
  throw new Error(`Timed out waiting for ClickClack reply marker ${marker}. State: ${state}`);
}

const commands = {
  "assert-onboard": assertOnboard,
  "remember-plugin-install-path": rememberPluginInstallPath,
  "configure-mock-model": configureMockModel,
  "assert-agent-turn": assertAgentTurn,
  "assert-file-contains": assertFileContains,
  "assert-plugin-uninstalled": assertPluginUninstalled,
  "configure-clickclack": configureClickClack,
  "assert-channel-status": assertChannelStatus,
  "post-clickclack-inbound": postClickClackInbound,
  "wait-clickclack-socket": waitClickClackSocket,
  "assert-clickclack-state": assertClickClackState,
  "wait-clickclack-reply": waitClickClackReply,
};

export async function runReleaseUserJourneyAssertion(command, args = []) {
  const fn = commands[command];
  if (!fn) {
    throw new Error(`unknown release-user-journey assertion command: ${command ?? "<missing>"}`);
  }
  const previousArgv = process.argv;
  process.argv = [previousArgv[0] ?? "node", fileURLToPath(import.meta.url), command, ...args];
  try {
    await fn();
  } finally {
    process.argv = previousArgv;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseUserJourneyAssertion(process.argv[2], process.argv.slice(3));
}
