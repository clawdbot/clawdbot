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
const token = requireEnv("OPENCLAW_GATEWAY_TOKEN");
const timeoutSeconds = Number.parseInt(
  process.env.OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS ?? "180",
  10,
);

const config = {
  gateway: {
    port: Number.parseInt(process.env.PORT ?? "18790", 10),
    bind: "loopback",
    auth: { mode: "token", token },
    controlUi: { enabled: false },
  },
  plugins: {
    enabled: true,
    allow: ["codex"],
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            mode: "yolo",
            command: "node",
            args: ["scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs"],
            requestTimeoutMs: timeoutSeconds * 1000,
            turnCompletionIdleTimeoutMs: timeoutSeconds * 1000,
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      agentRuntime: { id: "codex" },
      model: { primary: "codex/gpt-5.5", fallbacks: [] },
      models: {
        "codex/gpt-5.5": {
          agentRuntime: { id: "codex" },
        },
      },
      workspace: workspaceDir,
      skipBootstrap: true,
      timeoutSeconds,
      sandbox: { mode: "off" },
    },
    list: [
      {
        id: "main",
        default: true,
        agentRuntime: { id: "codex" },
        model: { primary: "codex/gpt-5.5", fallbacks: [] },
        workspace: workspaceDir,
      },
    ],
  },
  skills: { allowBundled: [] },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
