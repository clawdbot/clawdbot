// System prompt config tests cover config-to-prompt parameter resolution through
// the canonical agent prompt facade.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildConfiguredAgentSystemPrompt } from "./system-prompt-config.js";

vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

function buildPrompt(config: OpenClawConfig, agentId = "main", sessionKey?: string): string {
  return buildConfiguredAgentSystemPrompt({
    config,
    agentId,
    workspaceDir: "/tmp/openclaw",
    toolNames: ["sessions_spawn", "subagents"],
    runtimeInfo: { sessionKey },
  });
}

const assignmentCases = [
  {
    agentId: "main",
    agentName: "Coordinator",
    description: "Coordinates work and hands specialist execution to the matching agent.",
  },
  {
    agentId: "research",
    agentName: "Researcher",
    description: "Investigates evidence and hands implementation to the owning specialist.",
  },
  {
    agentId: "editor",
    agentName: "Editor",
    description: "Owns editorial quality and hands source disputes back to research.",
  },
  {
    agentId: "writer",
    agentName: "Writer",
    description: "Drafts approved work and hands final review to the editor.",
  },
  {
    agentId: "code-ops",
    agentName: "Code Operations",
    description: "Owns implementation and hands product decisions to the coordinator.",
  },
] as const;

describe("buildConfiguredAgentSystemPrompt", () => {
  it.each(assignmentCases)(
    "projects the $agentId agent's factual assignment",
    ({ agentId, agentName, description }) => {
      const prompt = buildPrompt(
        {
          agents: {
            entries: {
              [agentId]: { identity: { name: agentName }, description },
            },
          },
        },
        agentId,
      );

      expect(prompt).toContain(
        [
          "## Agent Assignment",
          "OpenClaw config is authoritative for agent ID, name, specialist scope, and handoff boundary.",
          `Agent ID: ${agentId}`,
          `Name: ${agentName}`,
          `Specialist scope and handoff boundary: ${description}`,
        ].join("\n"),
      );
    },
  );

  it("keeps the selected assignment in prompt mode none", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          entries: {
            worker: {
              identity: { name: "Worker" },
              description: "Handles bounded specialist work.",
            },
          },
        },
      },
      agentId: "worker",
      workspaceDir: "/tmp/openclaw",
      promptMode: "none",
    });

    expect(prompt).toContain(
      "## Agent Assignment\nOpenClaw config is authoritative for agent ID, name, specialist scope, and handoff boundary.\nAgent ID: worker\nName: Worker",
    );
    expect(prompt).toContain(
      "Specialist scope and handoff boundary: Handles bounded specialist work.",
    );
  });

  it("keeps config assignment authoritative over conflicting workspace identity", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          entries: {
            worker: {
              identity: { name: "Configured Worker" },
              description: "Owns configured specialist work.",
            },
          },
        },
      },
      agentId: "worker",
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        {
          path: "/tmp/openclaw/IDENTITY.md",
          content: "Name: Stale File Worker\nScope: Owns conflicting workspace work.",
        },
      ],
    });

    expect(prompt).toContain(
      "OpenClaw config is authoritative for agent ID, name, specialist scope, and handoff boundary.",
    );
    expect(prompt).toContain("Name: Configured Worker");
    expect(prompt).toContain("Name: Stale File Worker");
    expect(prompt.indexOf("Name: Configured Worker")).toBeLessThan(
      prompt.indexOf("Name: Stale File Worker"),
    );
  });

  it.each([
    {
      name: "prefers delegation in the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: true,
    },
    {
      name: "suggests delegation outside the canonical main session",
      config: {} satisfies OpenClawConfig,
      sessionKey: "agent:main:slack:channel:C01234567",
      expected: false,
    },
    {
      name: "recognizes a custom canonical main key",
      config: { session: { mainKey: "inbox" } } satisfies OpenClawConfig,
      sessionKey: "agent:main:inbox",
      expected: true,
    },
    {
      name: "recognizes the global-scope canonical main key",
      config: { session: { scope: "global" } } satisfies OpenClawConfig,
      sessionKey: "global",
      expected: true,
    },
    {
      name: "suggests delegation without a render session key",
      config: {} satisfies OpenClawConfig,
      sessionKey: undefined,
      expected: false,
    },
    {
      name: "honors explicit prefer outside the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "prefer" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:dashboard:project",
      expected: true,
    },
    {
      name: "honors explicit suggest in the canonical main session",
      config: {
        agents: { defaults: { subagents: { delegationMode: "suggest" } } },
      } satisfies OpenClawConfig,
      sessionKey: "agent:main:main",
      expected: false,
    },
  ])("$name", ({ config, sessionKey, expected }) => {
    const prompt = buildPrompt(config, "main", sessionKey);
    expect(prompt.includes("## Delegation")).toBe(expected);
    expect(prompt.includes("- Subagents: `sessions_spawn`")).toBe(!expected);
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

    expect(buildPrompt(config)).toContain("## Delegation");
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

    expect(buildPrompt(config, "coordinator")).toContain("## Delegation");
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

    expect(prompt).toContain("## Delegation");
  });
});
