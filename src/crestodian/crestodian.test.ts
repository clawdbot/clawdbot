import { describe, expect, it } from "vitest";
import { runCrestodian } from "./crestodian.js";
import { createCrestodianTestRuntime } from "./crestodian.test-helpers.js";
import type { CrestodianOverview } from "./overview.js";

const overview: CrestodianOverview = {
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
};

const crestodianOverviewDeps = {
  formatOverview: () => "Default model: openai/gpt-5.5",
  loadOverview: async () => overview,
};

describe("runCrestodian", () => {
  it("uses the assistant planner only to choose typed operations", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runGatewayRestartCalls = 0;
    let onReadyCalls = 0;

    await runCrestodian(
      {
        message: "the local bridge looks sleepy, poke it",
        deps: {
          runGatewayRestart: async () => {
            runGatewayRestartCalls += 1;
          },
        },
        onReady: () => {
          onReadyCalls += 1;
        },
        planWithAssistant: async () => ({
          reply: "I can queue a Gateway restart.",
          command: "restart gateway",
          modelLabel: "openai/gpt-5.5",
        }),
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(runGatewayRestartCalls).toBe(0);
    expect(onReadyCalls).toBe(0);
    expect(lines.join("\n")).toContain("[crestodian] planner: openai/gpt-5.5");
    expect(lines.join("\n")).toContain("[crestodian] interpreted: restart gateway");
    expect(lines.join("\n")).toContain("Plan: restart the Gateway. Say yes to apply.");
  });

  it("keeps deterministic parsing ahead of the assistant planner", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let plannerCalls = 0;
    let onReadyCalls = 0;

    await runCrestodian(
      {
        message: "models",
        planWithAssistant: async () => {
          plannerCalls += 1;
          return { command: "restart gateway" };
        },
        onReady: () => {
          onReadyCalls += 1;
        },
        ...crestodianOverviewDeps,
      },
      runtime,
    );

    expect(plannerCalls).toBe(0);
    expect(onReadyCalls).toBe(0);
    expect(lines.join("\n")).toContain("Default model:");
  });

  it("starts interactive Crestodian in the TUI shell", async () => {
    const { runtime, lines } = createCrestodianTestRuntime();
    let runInteractiveTuiCalls = 0;
    let onReadyCalls = 0;

    await runCrestodian(
      {
        input: { isTTY: true } as unknown as NodeJS.ReadableStream,
        output: { isTTY: true } as unknown as NodeJS.WritableStream,
        runInteractiveTui: async () => {
          runInteractiveTuiCalls += 1;
        },
        onReady: () => {
          onReadyCalls += 1;
        },
      },
      runtime,
    );

    expect(runInteractiveTuiCalls).toBe(1);
    expect(onReadyCalls).toBe(1);
    expect(lines.join("\n")).not.toContain("Say: status");
  });
});
