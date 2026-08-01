// Writes config fixtures for Codex media-path E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { readPositiveIntEnv, readTcpPortEnv } from "./limits.mjs";

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
const timeoutSeconds = readPositiveIntEnv("OPENCLAW_CODEX_MEDIA_PATH_TIMEOUT_SECONDS", 180);
const gatewayPort = readTcpPortEnv("PORT", 18790);

const config = {
  gateway: {
    port: gatewayPort,
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
      model: { primary: "openai/gpt-5.6-luna", fallbacks: [] },
      models: {
        "openai/gpt-5.6-luna": {
          agentRuntime: { id: "codex" },
        },
      },
      workspace: workspaceDir,
      skipBootstrap: true,
      timeoutSeconds,
      sandbox: { mode: "off" },
    },
    entries: {
      main: {
        default: true,
        model: { primary: "openai/gpt-5.6-luna", fallbacks: [] },
        models: {
          "openai/gpt-5.6-luna": {
            agentRuntime: { id: "codex" },
          },
        },
        workspace: workspaceDir,
      },
    },
  },
  skills: { allowBundled: [] },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
