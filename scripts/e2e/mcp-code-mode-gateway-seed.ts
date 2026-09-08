// Mcp Code Mode Gateway Seed script supports OpenClaw repository automation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyDockerOpenAiProviderConfig, type OpenClawConfig } from "./docker-openai-seed.ts";
import { writeProbeMcpServer } from "./lib/mcp-code-mode-probe-server.ts";

async function main() {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const workspaceDir = path.join(stateDir, "workspace");
  const serverPath = path.join(stateDir, "mcp-code-mode-fixture", "fixture-server.mjs");
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.OPENCLAW_MCP_CODE_MODE_OPENAI_API_KEY?.trim() ||
    "sk-docker-smoke-test";
  const legacyMemoryConfig = process.env.OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE === "agent";
  const agentDefaults = {
    heartbeat: {
      every: "0m",
    },
    ...(legacyMemoryConfig
      ? {
          memorySearch: {
            enabled: false,
            sync: { onSearch: false, onSessionStart: false, watch: false },
          },
        }
      : {}),
  };

  const cfg = applyDockerOpenAiProviderConfig(
    {
      gateway: {
        controlUi: {
          enabled: false,
        },
        http: {
          endpoints: {
            responses: {
              enabled: true,
            },
          },
        },
      },
      agents: {
        defaults: {
          ...agentDefaults,
        },
      },
      ...(legacyMemoryConfig ? {} : { memory: { search: { enabled: false } } }),
      plugins: {
        slots: {
          memory: "none",
        },
      },
      tools: {
        profile: "coding",
        alsoAllow: ["bundle-mcp"],
        codeMode: {
          enabled: true,
          timeoutMs: 20_000,
          maxPendingToolCalls: 16,
        },
      },
      mcp: {
        servers: {
          fixture: {
            command: "node",
            args: [serverPath],
            cwd: path.dirname(serverPath),
            connectionTimeoutMs: 30_000,
          },
        },
      },
    } satisfies OpenClawConfig,
    apiKey,
  );

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeProbeMcpServer(serverPath);
  await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      stateDir,
      configPath,
      workspaceDir,
      serverPath,
    })}\n`,
  );
}

await main();
