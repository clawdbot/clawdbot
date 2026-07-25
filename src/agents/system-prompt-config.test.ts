// System prompt config tests cover config-to-prompt parameter resolution through
// the canonical agent prompt facade.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

function buildPrompt(config: OpenClawConfig, agentId = "main"): string {
  return buildConfiguredAgentSystemPrompt({
    config,
    agentId,
    workspaceDir: "/tmp/openclaw",
    toolNames: ["sessions_spawn", "subagents"],
  });
}

describe("buildConfiguredAgentSystemPrompt", () => {
  it("defaults sub-agent delegation mode to suggest", () => {
    expect(buildPrompt({})).not.toContain("Mode: prefer");
  });

  it("inherits default sub-agent delegation mode", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config)).toContain("Mode: prefer");
  });

  it("lets per-agent sub-agent delegation mode override defaults", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "suggest",
          },
        },
        list: [
          {
            id: "coordinator",
            subagents: {
              delegationMode: "prefer",
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(buildPrompt(config, "coordinator")).toContain("Mode: prefer");
  });

  it("applies config-backed prompt parameters through the canonical facade", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
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
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
  });
});
