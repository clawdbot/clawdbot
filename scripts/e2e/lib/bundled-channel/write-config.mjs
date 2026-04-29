import fs from "node:fs";
import path from "node:path";

const mode = process.argv[2];
const token = process.argv[3];
const port = Number(process.argv[4]);
const configPath =
  process.env.OPENCLAW_BUNDLED_CHANNEL_CONFIG_PATH ||
  path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};

if (mode === "disabled-config") {
  const stateDir = path.dirname(configPath);
  const disabledConfig = {
    gateway: {
      mode: "local",
      auth: {
        mode: "token",
        token: "disabled-config-runtime-deps-token",
      },
    },
    plugins: {
      enabled: true,
      entries: {
        discord: { enabled: false },
      },
    },
    channels: {
      telegram: {
        enabled: false,
        botToken: "123456:disabled-config-token",
        dmPolicy: "disabled",
        groupPolicy: "disabled",
      },
      slack: {
        enabled: false,
        botToken: "xoxb-disabled-config-token",
        appToken: "xapp-disabled-config-token",
      },
      discord: {
        enabled: true,
        token: "disabled-plugin-entry-token",
        dmPolicy: "disabled",
        groupPolicy: "disabled",
      },
    },
  };
  fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(disabledConfig, null, 2)}\n`, "utf8");
  fs.chmodSync(stateDir, 0o700);
  fs.chmodSync(configPath, 0o600);
  process.exit(0);
}

config.gateway = {
  ...config.gateway,
  port,
  auth: { mode: "token", token },
  controlUi: { enabled: false },
};
config.agents = {
  ...config.agents,
  defaults: {
    ...config.agents?.defaults,
    model: { primary: "openai/gpt-4.1-mini" },
  },
};
config.models = {
  ...config.models,
  providers: {
    ...config.models?.providers,
    openai: {
      ...config.models?.providers?.openai,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      models: [],
    },
  },
};
config.plugins = {
  ...config.plugins,
  enabled: true,
};
config.channels = {
  ...config.channels,
  telegram: {
    ...config.channels?.telegram,
    enabled: mode === "telegram",
    botToken:
      process.env.OPENCLAW_BUNDLED_CHANNEL_TELEGRAM_TOKEN || "123456:bundled-channel-update-token",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  discord: {
    ...config.channels?.discord,
    enabled: mode === "discord",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  slack: {
    ...config.channels?.slack,
    enabled: mode === "slack",
    botToken:
      process.env.OPENCLAW_BUNDLED_CHANNEL_SLACK_BOT_TOKEN || "xoxb-bundled-channel-update-token",
    appToken:
      process.env.OPENCLAW_BUNDLED_CHANNEL_SLACK_APP_TOKEN || "xapp-bundled-channel-update-token",
  },
  feishu: {
    ...config.channels?.feishu,
    enabled: mode === "feishu",
  },
};
if (mode === "memory-lancedb") {
  config.plugins = {
    ...config.plugins,
    enabled: true,
    allow: [...new Set([...(config.plugins?.allow || []), "memory-lancedb"])],
    slots: {
      ...config.plugins?.slots,
      memory: "memory-lancedb",
    },
    entries: {
      ...config.plugins?.entries,
      "memory-lancedb": {
        ...config.plugins?.entries?.["memory-lancedb"],
        enabled: true,
        config: {
          ...config.plugins?.entries?.["memory-lancedb"]?.config,
          embedding: {
            ...config.plugins?.entries?.["memory-lancedb"]?.config?.embedding,
            apiKey: process.env.OPENAI_API_KEY,
            model: "text-embedding-3-small",
          },
          dbPath:
            process.env.OPENCLAW_BUNDLED_CHANNEL_MEMORY_DB_PATH || "~/.openclaw/memory/lancedb-e2e",
          autoCapture: false,
          autoRecall: false,
        },
      },
    },
  };
}
if (mode === "acpx") {
  config.plugins = {
    ...config.plugins,
    enabled: true,
    allow:
      Array.isArray(config.plugins?.allow) && config.plugins.allow.length > 0
        ? [...new Set([...config.plugins.allow, "acpx"])]
        : config.plugins?.allow,
    entries: {
      ...config.plugins?.entries,
      acpx: {
        ...config.plugins?.entries?.acpx,
        enabled: true,
      },
    },
  };
}
if (mode === "setup-entry-channels") {
  config.plugins = {
    ...config.plugins,
    enabled: true,
  };
  config.channels = {
    ...config.channels,
    feishu: {
      ...config.channels?.feishu,
      enabled: true,
    },
    whatsapp: {
      ...config.channels?.whatsapp,
      enabled: true,
    },
  };
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
