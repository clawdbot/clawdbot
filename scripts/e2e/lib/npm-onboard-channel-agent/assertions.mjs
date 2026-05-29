import fs from "node:fs";
import path from "node:path";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import { applyMockOpenAiModelConfig } from "../fixtures/mock-openai-config.mjs";

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
  applyMockOpenAiModelConfig(cfg, { mockPort });
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

function assertMockModelConfig() {
  const mockPort = Number(process.argv[3]);
  const expectedModelRef = "openai/gpt-5.5";
  const expectedBaseUrl = `http://127.0.0.1:${mockPort}/v1`;
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const cfg = readJson(configPath);
  const provider = cfg.models?.providers?.openai;
  const defaultModel = cfg.agents?.defaults?.model?.primary;
  const defaultRuntime = cfg.agents?.defaults?.models?.[expectedModelRef]?.agentRuntime?.id;
  const agent = Array.isArray(cfg.agents?.list)
    ? (cfg.agents.list.find((entry) => entry?.id === "main") ?? cfg.agents.list[0])
    : undefined;
  const agentModel = agent?.model?.primary;
  const agentRuntime = agent?.models?.[expectedModelRef]?.agentRuntime?.id;
  if (provider?.baseUrl !== expectedBaseUrl) {
    throw new Error(
      `mock OpenAI baseUrl was not preserved; expected ${expectedBaseUrl}, got ${provider?.baseUrl}`,
    );
  }
  if (provider?.api !== "openai-responses") {
    throw new Error(`mock OpenAI api was not preserved; got ${provider?.api}`);
  }
  if (provider?.agentRuntime?.id !== "openclaw") {
    throw new Error(`mock OpenAI runtime was not preserved; got ${provider?.agentRuntime?.id}`);
  }
  if (defaultModel !== expectedModelRef) {
    throw new Error(
      `mock default model was not preserved; expected ${expectedModelRef}, got ${defaultModel}`,
    );
  }
  if (defaultRuntime !== "openclaw") {
    throw new Error(`mock default runtime was not preserved; got ${defaultRuntime}`);
  }
  if (agent && agentModel !== expectedModelRef) {
    throw new Error(
      `mock agent model was not preserved; expected ${expectedModelRef}, got ${agentModel}`,
    );
  }
  if (agent && agentRuntime !== "openclaw") {
    throw new Error(`mock agent runtime was not preserved; got ${agentRuntime}`);
  }
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
  assertAgentReplyContainsMarker(marker, "/tmp/openclaw-agent.combined");
  assertOpenAiRequestLogUsed(logPath);
}

const commands = {
  "assert-onboard-state": assertOnboardState,
  "configure-mock-model": configureMockModel,
  "assert-mock-model-config": assertMockModelConfig,
  "assert-channel-config": assertChannelConfig,
  "assert-status-surfaces": assertStatusSurfaces,
  "assert-agent-turn": assertAgentTurn,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown npm onboard/channel/agent assertion command: ${command}`);
}
fn();
