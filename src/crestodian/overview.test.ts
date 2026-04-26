import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: command === "codex",
    version: command === "codex" ? "codex 1.0.0" : undefined,
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    issues: [],
    hash: "test-hash",
    runtimeConfig: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.2" } },
        list: [
          { id: "main", default: true },
          { id: "work", name: "Work" },
        ],
      },
      gateway: { port: 19001 },
    },
    sourceConfig: undefined,
  })),
  resolveConfigPath: vi.fn(() => "/tmp/openclaw.json"),
  resolveGatewayPort: vi.fn((cfg: { gateway?: { port?: number } }) => cfg.gateway?.port ?? 8765),
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: vi.fn((input: { config: { gateway?: { port?: number } } }) => ({
    url: `ws://127.0.0.1:${input.config.gateway?.port ?? 8765}`,
    urlSource: "local loopback",
  })),
}));

describe("loadCrestodianOverview", () => {
  const previousTestFast = process.env.OPENCLAW_TEST_FAST;

  afterEach(() => {
    if (previousTestFast === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousTestFast;
    }
  });

  it("summarizes config, agents, model, tools, and gateway", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");

    const { formatCrestodianOverview, formatCrestodianStartupMessage, loadCrestodianOverview } =
      await import("./overview.js");
    const overview = await loadCrestodianOverview();

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
