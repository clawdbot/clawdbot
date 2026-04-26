import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCrestodian } from "./crestodian.js";
import { createCrestodianTestRuntime } from "./crestodian.test-helpers.js";

vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: false,
    error: "not found",
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

vi.mock("./overview.js", () => ({
  formatCrestodianOverview: () => "Default model: openai/gpt-5.5",
  loadCrestodianOverview: vi.fn(async () => ({
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    agents: [{ id: "main", isDefault: true, model: "openai/gpt-5.5" }],
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    tools: {
      codex: { command: "codex", found: false, error: "not found" },
      claude: { command: "claude", found: false, error: "not found" },
      apiKeys: { openai: true, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "local loopback",
      reachable: false,
      error: "offline",
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  })),
}));

describe("runCrestodian", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the assistant planner only to choose typed operations", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-run-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createCrestodianTestRuntime();
    const runGatewayRestart = vi.fn(async () => {});
    const onReady = vi.fn();

    await runCrestodian(
      {
        message: "the local bridge looks sleepy, poke it",
        deps: { runGatewayRestart },
        onReady,
        planWithAssistant: async () => ({
          reply: "I can queue a Gateway restart.",
          command: "restart gateway",
          modelLabel: "openai/gpt-5.5",
        }),
      },
      runtime,
    );

    expect(runGatewayRestart).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("[crestodian] planner: openai/gpt-5.5");
    expect(lines.join("\n")).toContain("[crestodian] interpreted: restart gateway");
    expect(lines.join("\n")).toContain("Plan: restart the Gateway. Say yes to apply.");
  });

  it("keeps deterministic parsing ahead of the assistant planner", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-run-deterministic-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createCrestodianTestRuntime();
    const planner = vi.fn(async () => ({ command: "restart gateway" }));
    const onReady = vi.fn();

    await runCrestodian(
      {
        message: "models",
        planWithAssistant: planner,
        onReady,
      },
      runtime,
    );

    expect(planner).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Default model:");
  });

  it("starts interactive Crestodian in the TUI shell", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-run-tui-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createCrestodianTestRuntime();
    const runInteractiveTui = vi.fn(async () => {});
    const onReady = vi.fn();

    await runCrestodian(
      {
        input: { isTTY: true } as unknown as NodeJS.ReadableStream,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
        runInteractiveTui,
        onReady,
      },
      runtime,
    );

    expect(runInteractiveTui).toHaveBeenCalledWith(
      expect.objectContaining({ runInteractiveTui }),
      runtime,
    );
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(lines.join("\n")).not.toContain("Say: status");
  });
});
