import path from "node:path";
import { requireArg, writeJson } from "./common.mjs";

function writeConfig(kind) {
  const configPath = requireArg(process.env.OPENCLAW_CONFIG_PATH, "OPENCLAW_CONFIG_PATH");
  const port = Number(process.env.PORT ?? 18789);
  const config =
    kind === "config-reload"
      ? {
          gateway: {
            port,
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "GATEWAY_AUTH_TOKEN_REF" },
            },
            channelHealthCheckMinutes: 1,
            controlUi: { enabled: false },
            reload: { mode: "hybrid", debounceMs: 0 },
          },
        }
      : kind === "browser-cdp"
        ? {
            gateway: {
              port,
              auth: {
                mode: "token",
                token: requireArg(process.env.OPENCLAW_GATEWAY_TOKEN, "OPENCLAW_GATEWAY_TOKEN"),
              },
              controlUi: { enabled: false },
            },
            browser: {
              enabled: true,
              defaultProfile: "docker-cdp",
              ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
              profiles: {
                "docker-cdp": {
                  cdpUrl: `http://127.0.0.1:${Number(process.env.CDP_PORT ?? 19222)}`,
                  color: "#FF4500",
                },
              },
            },
          }
        : null;
  writeJson(configPath, requireArg(config, "known config kind"));
}

function writeOpenAiWebSearchMinimalConfig() {
  writeJson(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"), {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5" },
        models: {
          "openai/gpt-5": {
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "http://api.openai.com/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "gpt-5",
              name: "gpt-5",
              api: "openai-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              contextTokens: 96000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    tools: { web: { search: { enabled: true, maxResults: 3 } } },
    plugins: { enabled: true, allow: ["openai"], entries: { openai: { enabled: true } } },
    gateway: { auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN } },
  });
}

function writeOpenWebUiConfig([openaiApiKey]) {
  const batchPath = requireArg(
    process.env.OPENCLAW_CONFIG_BATCH_PATH,
    "OPENCLAW_CONFIG_BATCH_PATH",
  );
  writeJson(batchPath, [
    { path: "models.providers.openai.apiKey", value: requireArg(openaiApiKey, "OpenAI API key") },
    {
      path: "models.providers.openai.baseUrl",
      value: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
    },
    { path: "models.providers.openai.models", value: [] },
    {
      path: "models.providers.openai.timeoutSeconds",
      value: Number.parseInt(process.env.OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS ?? "900", 10),
    },
    { path: "models.providers.openai.agentRuntime", value: { id: "pi" } },
    { path: "gateway.controlUi.enabled", value: false },
    { path: "gateway.mode", value: "local" },
    { path: "gateway.bind", value: "lan" },
    { path: "gateway.auth.mode", value: "token" },
    { path: "gateway.auth.token", value: process.env.OPENCLAW_GATEWAY_TOKEN },
    { path: "gateway.http.endpoints.chatCompletions.enabled", value: true },
    { path: "agents.defaults.model.primary", value: process.env.OPENCLAW_OPENWEBUI_MODEL },
  ]);
}

export const configCommands = {
  "config-reload": () => writeConfig("config-reload"),
  "browser-cdp": () => writeConfig("browser-cdp"),
  "openai-web-search-minimal-config": writeOpenAiWebSearchMinimalConfig,
  "openwebui-config": writeOpenWebUiConfig,
};
