import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildAgentSummaries } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/config.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listAgentsForGateway } from "./session-utils.js";

describe("explicit agent roster visibility", () => {
  test("agents.entries keeps Gateway and CLI scoped to the configured roster", async () => {
    await withStateDirEnv("openclaw-agent-entries-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: {
          entries: {
            main: { default: true },
          },
        },
      } as OpenClawConfig;

      const gatewayAgents = listAgentsForGateway(cfg).agents.map((agent) => agent.id);
      const cliAgents = buildAgentSummaries(cfg).map((agent) => agent.id);

      expect(gatewayAgents).toEqual(["main"]);
      expect(cliAgents).toEqual(["main"]);
    });
  });

  test("agents.list compatibility shape keeps the same explicit scope", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const gatewayAgents = listAgentsForGateway(cfg).agents.map((agent) => agent.id);
      const cliAgents = buildAgentSummaries(cfg).map((agent) => agent.id);

      expect(gatewayAgents).toEqual(["main"]);
      expect(cliAgents).toEqual(["main"]);
    });
  });
});
