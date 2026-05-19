import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { buildCliAgentSystemPrompt } from "./helpers.js";

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

describe("buildCliAgentSystemPrompt", () => {
  afterEach(() => {
    clearPluginCommands();
  });

  it("uses config-backed sub-agent delegation mode", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      tools: [{ name: "sessions_spawn" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
    expect(prompt).not.toContain("For long waits, avoid rapid poll loops");
    expect(prompt).not.toContain("Larger work: use `sessions_spawn`");
    expect(prompt).not.toContain("Do not poll `subagents list` / `sessions_list` in a loop");
  });

  it("uses CLI backend tool fallback instead of PI tool assumptions", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).not.toContain("Pi lists the standard tools above");
    expect(prompt).not.toContain("This runtime enables:");
    expect(prompt).not.toContain("For long waits, avoid rapid poll loops");
    expect(prompt).not.toContain("Larger work: use `sessions_spawn`");
    expect(prompt).not.toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).toContain("No OpenClaw tool list is injected");
  });

  it("includes CLI-scoped plugin command guidance", () => {
    registerPluginCommand("demo-plugin", {
      name: "demo_cli",
      description: "Demo CLI command",
      agentPromptGuidance: [
        {
          text: "CLI-only command guidance.",
          surfaces: ["cli_backend"],
        },
        {
          text: "PI-only command guidance.",
          surfaces: ["pi_main"],
        },
      ],
      handler: async () => ({ text: "ok" }),
    });

    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "exec" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("CLI-only command guidance.");
    expect(prompt).not.toContain("PI-only command guidance.");
  });
});
