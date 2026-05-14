import fs from "node:fs";
import path from "node:path";

const command = process.argv[2];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
  const mockPort = Number(process.argv[3]);
  const cfg = readJson(configPath());
  const modelRef = "openai/gpt-5.5";
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  cfg.models = {
    ...cfg.models,
    mode: "merge",
    providers: {
      ...cfg.models?.providers,
      openai: {
        ...cfg.models?.providers?.openai,
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        api: "openai-responses",
        request: { ...cfg.models?.providers?.openai?.request, allowPrivateNetwork: true },
        models: [
          {
            id: "gpt-5.5",
            name: "gpt-5.5",
            api: "openai-responses",
            reasoning: false,
            input: ["text", "image"],
            cost,
            contextWindow: 128000,
            contextTokens: 96000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  cfg.agents = {
    ...cfg.agents,
    defaults: {
      ...cfg.agents?.defaults,
      model: { primary: modelRef },
      models: {
        ...cfg.agents?.defaults?.models,
        [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
      },
    },
  };
  cfg.plugins = {
    ...cfg.plugins,
    enabled: true,
  };
  writeConfig(cfg);
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const outputPath = process.argv[4];
  const requestLogPath = process.argv[5];
  const output = fs.readFileSync(outputPath, "utf8");
  assert(output.includes(marker), `agent output did not contain marker. Output: ${output}`);
  const requestLog = fs.existsSync(requestLogPath) ? fs.readFileSync(requestLogPath, "utf8") : "";
  assert(
    /\/v1\/(responses|chat\/completions)/u.test(requestLog),
    "mock OpenAI server was not used",
  );
}

function assertFileContains() {
  const file = process.argv[3];
  const needle = process.argv[4];
  const raw = fs.readFileSync(file, "utf8");
  assert(raw.includes(needle), `${file} did not contain ${needle}. Output: ${raw}`);
}

function assertPluginUninstalled() {
  const pluginId = process.argv[3];
  const cfg = readJson(configPath());
  const recordsPath = path.join(process.env.HOME ?? "", ".openclaw", "plugins", "installs.json");
  const records = fs.existsSync(recordsPath) ? readJson(recordsPath) : {};
  const installRecords = records.installRecords ?? records.records ?? {};
  assert(!installRecords[pluginId], `install record still present for ${pluginId}`);
  assert(!cfg.plugins?.entries?.[pluginId], `plugin config entry still present for ${pluginId}`);
  assert(!(cfg.plugins?.allow ?? []).includes(pluginId), `allowlist still contains ${pluginId}`);
  assert(!(cfg.plugins?.deny ?? []).includes(pluginId), `denylist still contains ${pluginId}`);
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
          allowedModels: ["openai/gpt-5.5"],
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
      model: "openai/gpt-5.5",
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
  const response = await fetch(`${baseUrl}/fixture/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  assert(response.ok, `fixture inbound failed: ${response.status} ${await response.text()}`);
}

async function waitClickClackSocket() {
  const baseUrl = process.argv[3];
  const timeoutSeconds = Number(process.argv[4] ?? 30);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/fixture/state`).catch(() => undefined);
    if (response?.ok) {
      const state = await response.json();
      if (Number(state.socketCount ?? 0) > 0) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
  const timeoutSeconds = Number(process.argv[5] ?? 30);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(statePath)) {
      const state = readJson(statePath);
      if (JSON.stringify(state.threadReplies ?? []).includes(marker)) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "<missing>";
  throw new Error(`Timed out waiting for ClickClack reply marker ${marker}. State: ${state}`);
}

const commands = {
  "assert-onboard": assertOnboard,
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

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown release-user-journey assertion command: ${command ?? "<missing>"}`);
}
await fn();
