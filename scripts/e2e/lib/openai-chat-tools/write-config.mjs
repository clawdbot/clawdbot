import fs from "node:fs";
import path from "node:path";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const configPath = requireEnv("OPENCLAW_CONFIG_PATH");
const stateDir = requireEnv("OPENCLAW_STATE_DIR");
const workspaceDir = requireEnv("OPENCLAW_TEST_WORKSPACE_DIR");
const modelRef = requireEnv("OPENCLAW_OPENAI_CHAT_TOOLS_MODEL");
const token = requireEnv("OPENCLAW_GATEWAY_TOKEN");
const timeoutSeconds = Number.parseInt(
  process.env.OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS ?? "180",
  10,
);
const [providerId, modelId] = modelRef.split("/");
if (providerId !== "openai" || !modelId) {
  throw new Error(`OPENCLAW_OPENAI_CHAT_TOOLS_MODEL must be openai/*, got ${modelRef}`);
}

const config = {
  gateway: {
    port: Number.parseInt(process.env.PORT ?? "18789", 10),
    bind: "loopback",
    auth: { mode: "token", token },
    controlUi: { enabled: false },
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      openai: {
        api: "openai-responses",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
        agentRuntime: { id: "pi" },
        timeoutSeconds,
        models: [
          {
            id: modelId,
            name: modelId,
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            contextTokens: 64000,
            maxTokens: 512,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: modelRef, fallbacks: [] },
      models: {
        [modelRef]: {
          agentRuntime: { id: "pi" },
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
      workspace: workspaceDir,
      skipBootstrap: true,
      timeoutSeconds,
      contextTokens: 64000,
    },
  },
  plugins: {
    enabled: true,
    allow: ["openai"],
    entries: { openai: { enabled: true } },
  },
  skills: { allowBundled: [] },
  tools: { allow: ["get_weather"] },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
