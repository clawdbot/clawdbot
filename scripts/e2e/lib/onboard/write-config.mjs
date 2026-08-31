// Config writer helper for onboard E2E scenarios.
import fs from "node:fs";
import { applyMockOpenAiModelConfig } from "../fixtures/mock-openai-config.mjs";

const [scenario, configPath, ...scenarioArgs] = process.argv.slice(2);
if (!scenario || !configPath) {
  throw new Error(
    "usage: write-config.mjs <reset|skills|guided-skip-ui|multi-agent> <config-path> [...args]",
  );
}

let config;
if (scenario === "guided-skip-ui") {
  const [workspace, mockPort] = scenarioArgs;
  if (!workspace || !mockPort) {
    throw new Error("guided-skip-ui requires workspace and mock OpenAI port arguments");
  }
  config = {
    gateway: { mode: "local", bind: "loopback", controlUi: { enabled: false } },
    agents: { defaults: { workspace } },
    wizard: {
      securityAcknowledgedAt: "2026-01-01T00:00:00.000Z",
      accessMode: "full",
      appRecommendations: false,
    },
  };
  applyMockOpenAiModelConfig(config, { mockPort });
} else {
  config = {
    "multi-agent": {
      meta: {},
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: "/tmp/openclaw-main-workspace" },
          ops: { workspace: "/tmp/openclaw-ops-workspace" },
        },
      },
    },
    reset: {
      meta: {},
      agents: { defaults: { workspace: "/root/old" } },
      gateway: { mode: "remote", remote: { url: "ws://old.example:18789", token: "old-token" } },
    },
    skills: { meta: {}, skills: { allowBundled: ["__none__"], install: { nodeManager: "bun" } } },
  }[scenario];
}
if (!config) {
  throw new Error(`unknown config scenario: ${scenario}`);
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
