#!/usr/bin/env node
import fs from "node:fs";

const [configPath, mockPort, groupId, driverToken, sutToken, packageVersion] =
  process.argv.slice(2);

if (!configPath || !mockPort || !groupId || !driverToken || !sutToken || !packageVersion) {
  throw new Error(
    "usage: npm-telegram-rtt-config.mjs <config> <mock-port> <group-id> <driver-token> <sut-token> <package-version>",
  );
}

const driverId = driverToken.split(":", 1)[0];
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};

function supportsVisibleReplies(version) {
  const match = /(\d{4})\.(\d+)\.(\d+)/u.exec(version);
  if (!match) {
    return false;
  }
  const [, year, month, day] = match.map(Number);
  return year > 2026 || (year === 2026 && (month > 4 || (month === 4 && day >= 27)));
}

config.gateway = {
  mode: "local",
  port: 18789,
  bind: "loopback",
  auth: { mode: "none" },
};

config.models = config.models ?? {};
config.models.providers = config.models.providers ?? {};
config.models.providers.openai = {
  api: "openai-responses",
  apiKey: {
    source: "env",
    provider: "default",
    id: "OPENAI_API_KEY",
  },
  baseUrl: `http://127.0.0.1:${mockPort}/v1`,
  request: { allowPrivateNetwork: true },
  models: [
    {
      id: "gpt-5.5",
      name: "gpt-5.5",
      api: "openai-responses",
      contextWindow: 128000,
    },
  ],
};

config.agents = config.agents ?? {};
config.agents.defaults = config.agents.defaults ?? {};
config.agents.defaults.model = { primary: "openai/gpt-5.5" };
config.agents.defaults.models = {
  "openai/gpt-5.5": {
    params: {
      transport: "sse",
      openaiWsWarmup: false,
    },
  },
};
config.agents.list = [
  {
    id: "main",
    default: true,
    name: "Main",
    workspace: "~/workspace",
    model: { primary: "openai/gpt-5.5" },
  },
];

config.plugins = config.plugins ?? {};
config.plugins.enabled = true;
config.plugins.allow = ["telegram", "openai"];
config.plugins.entries = {
  telegram: { enabled: true },
  openai: { enabled: true },
};

config.channels = config.channels ?? {};
config.channels.telegram = {
  enabled: true,
  botToken: {
    source: "env",
    provider: "default",
    id: "TELEGRAM_BOT_TOKEN",
  },
  dmPolicy: "allowlist",
  allowFrom: [driverId],
  defaultTo: driverId,
  groupPolicy: "allowlist",
  groupAllowFrom: [driverId],
  groups: {
    [groupId]: {
      requireMention: false,
      allowFrom: [driverId],
    },
  },
};

if (supportsVisibleReplies(packageVersion)) {
  config.messages = {
    ...config.messages,
    groupChat: {
      ...config.messages?.groupChat,
      visibleReplies: "automatic",
    },
  };
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
