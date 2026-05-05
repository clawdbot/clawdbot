import fs from "node:fs";
import path from "node:path";

const command = process.argv[2];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function assertOnboardState() {
  const home = process.argv[3];
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const authPath = path.join(agentDir, "auth-profiles.json");

  if (!fs.existsSync(configPath)) {
    throw new Error("onboard did not write openclaw.json");
  }
  if (!fs.existsSync(agentDir)) {
    throw new Error("onboard did not create main agent dir");
  }
  if (!fs.existsSync(authPath)) {
    throw new Error("onboard did not create auth-profiles.json");
  }
  const authRaw = fs.readFileSync(authPath, "utf8");
  if (!authRaw.includes("OPENAI_API_KEY")) {
    throw new Error("auth profile did not persist OPENAI_API_KEY env ref");
  }
  if (authRaw.includes("sk-openclaw-npm-onboard-e2e")) {
    throw new Error("auth profile persisted the raw OpenAI test key");
  }
}

function configureMockModel() {
  const mockPort = Number(process.argv[3]);
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const cfg = readJson(configPath);
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
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

function assertChannelConfig() {
  const channel = process.argv[3];
  const expectedTokens = process.argv.slice(4);
  if (expectedTokens.length === 0) {
    throw new Error("assert-channel-config requires at least one expected token");
  }
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const cfg = readJson(configPath);
  const entry = cfg.channels?.[channel];
  if (!entry || entry.enabled === false) {
    throw new Error(`${channel} was not enabled`);
  }
  const serializedEntry = JSON.stringify(entry);
  for (const token of expectedTokens) {
    if (!serializedEntry.includes(token)) {
      throw new Error(`${channel} token was not persisted`);
    }
  }
}

function assertStatusSurfaces() {
  const channel = process.argv[3];
  const channelsStatusPath = process.argv[4];
  const statusTextPath = process.argv[5];
  const channelsStatus = readJson(channelsStatusPath);
  const configuredChannels = Array.isArray(channelsStatus.configuredChannels)
    ? channelsStatus.configuredChannels
    : [];
  if (!configuredChannels.includes(channel)) {
    throw new Error(
      `channels status did not list configured channel ${channel}. Payload: ${JSON.stringify(channelsStatus)}`,
    );
  }
  const statusText = fs.readFileSync(statusTextPath, "utf8");
  if (!/channels/i.test(statusText)) {
    throw new Error(`plain status output did not render a Channels section. Output: ${statusText}`);
  }
  if (!statusText.toLowerCase().includes(channel.toLowerCase())) {
    throw new Error(`plain status output did not mention ${channel}. Output: ${statusText}`);
  }
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const logPath = process.argv[4];
  const output = fs.readFileSync("/tmp/openclaw-agent.combined", "utf8");
  if (!output.includes(marker)) {
    throw new Error(`agent JSON did not contain success marker. Output: ${output}`);
  }
  const requestLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  if (!/\/v1\/(responses|chat\/completions)/u.test(requestLog)) {
    throw new Error(`mock OpenAI server was not used. Requests: ${requestLog}`);
  }
}

const commands = {
  "assert-onboard-state": assertOnboardState,
  "configure-mock-model": configureMockModel,
  "assert-channel-config": assertChannelConfig,
  "assert-status-surfaces": assertStatusSurfaces,
  "assert-agent-turn": assertAgentTurn,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown npm onboard/channel/agent assertion command: ${command}`);
}
fn();
