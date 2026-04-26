import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  runTui: vi.fn(async (_opts: unknown) => ({ exitReason: "exit" as const })),
}));

vi.mock("../tui/tui.js", () => ({
  runTui: mocks.runTui,
}));

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
  formatCrestodianStartupMessage: () => "Default model: openai/gpt-5.5",
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

import { runCrestodianTui } from "./tui-backend.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("runCrestodianTui", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.runTui.mockClear();
  });

  it("runs Crestodian inside the shared TUI shell", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-tui-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));

    await runCrestodianTui({}, createRuntime());

    expect(mocks.runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        local: true,
        session: "agent:crestodian:main",
        historyLimit: 200,
        config: {},
        title: "openclaw crestodian",
      }),
    );
    const callOptions = mocks.runTui.mock.calls[0]?.[0] as { backend?: unknown } | undefined;
    expect(callOptions?.backend).toBeTruthy();
  });
});
