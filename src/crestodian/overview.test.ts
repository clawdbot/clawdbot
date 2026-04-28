import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  formatCrestodianOverview,
  formatCrestodianStartupMessage,
  loadCrestodianOverview,
} from "./overview.js";

describe("loadCrestodianOverview", () => {
  it("summarizes config, agents, model, tools, and gateway", async () => {
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.2" } },
        list: [
          { id: "main", default: true },
          { id: "work", name: "Work" },
        ],
      },
      gateway: { port: 19001 },
    };
    const snapshot: ConfigFileSnapshot = {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: runtimeConfig,
      sourceConfig: runtimeConfig,
      resolved: runtimeConfig,
      valid: true,
      runtimeConfig,
      config: runtimeConfig,
      hash: "test-hash",
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
    const overview = await loadCrestodianOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        resolveConfigPath: () => "/tmp/openclaw.json",
        resolveGatewayPort: (cfg) => cfg?.gateway?.port ?? 8765,
        buildGatewayConnectionDetails: (input) => ({
          url: `ws://127.0.0.1:${input.config.gateway?.port ?? 8765}`,
          urlSource: "local loopback",
        }),
        probeLocalCommand: async (command) => ({
          command,
          found: command === "codex",
          version: command === "codex" ? "codex 1.0.0" : undefined,
        }),
        probeGatewayUrl: async (url) => ({ reachable: false, url, error: "offline" }),
      },
    });

    expect(overview.config).toMatchObject({
      exists: true,
      valid: true,
    });
    expect(overview.defaultAgentId).toBe("main");
    expect(overview.defaultModel).toBe("openai/gpt-5.2");
    expect(overview.agents.map((agent) => agent.id)).toEqual(["main", "work"]);
    expect(overview.tools.codex.found).toBe(true);
    expect(overview.tools.claude.found).toBe(false);
    expect(overview.gateway).toMatchObject({
      url: "ws://127.0.0.1:19001",
      reachable: false,
    });
    expect(overview.references.docsPath).toMatch(/docs$/);
    expect(overview.references.sourceUrl).toBe("https://github.com/openclaw/openclaw");
    expect(formatCrestodianOverview(overview)).toContain(
      'Next: run "gateway status" or "restart gateway"',
    );
    const startup = formatCrestodianStartupMessage(overview);
    expect(startup).toContain("## Hi, I'm Crestodian.");
    expect(startup).toContain("Using: openai/gpt-5.2");
    expect(startup).toContain("Gateway: not reachable");
    expect(startup).toContain("I can start debugging with `gateway status`");
    expect(startup).not.toContain("Codex:");
    expect(startup).not.toContain("Claude Code:");
    expect(startup).not.toContain("API keys:");
  });
});
