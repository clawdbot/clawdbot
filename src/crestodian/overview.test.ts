import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";

vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: command === "codex",
    version: command === "codex" ? "codex 1.0.0" : undefined,
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

describe("loadCrestodianOverview", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousTestFast = process.env.OPENCLAW_TEST_FAST;

  afterEach(() => {
    resetConfigRuntimeState();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousTestFast === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousTestFast;
    }
  });

  it("summarizes config, agents, model, tools, and gateway", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-overview-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    await fs.writeFile(
      path.join(tempDir, "openclaw.json"),
      `${JSON.stringify(
        {
          agents: {
            defaults: { model: { primary: "openai/gpt-5.2" } },
            list: [
              { id: "main", default: true },
              { id: "work", name: "Work" },
            ],
          },
          gateway: { port: 19001 },
        },
        null,
        2,
      )}\n`,
    );

    const { formatCrestodianOverview, loadCrestodianOverview } = await import("./overview.js");
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
      'Next: say "gateway status" or "restart gateway"',
    );
  });
});
