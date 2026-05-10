import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentsListTool } from "./agents-list-tool.js";

const loadConfigMock = vi.fn<() => OpenClawConfig>();

type AgentListDetails = {
  requester?: string;
  allowAny?: boolean;
  agents?: Array<{
    id?: string;
    name?: string;
    configured?: boolean;
    model?: string;
    agentRuntime?: { id?: string; source?: string };
  }>;
};

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

describe("agents_list tool", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    loadConfigMock.mockReset();
  });

  it("returns model and agent runtime metadata for allowed agents", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4.5",
          agentRuntime: { id: "pi" },
          subagents: { allowAgents: ["codex"] },
        },
        list: [
          { id: "main", default: true },
          {
            id: "codex",
            name: "Codex",
            model: "openai/gpt-5.5",
            agentRuntime: { id: "pi" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;

    expect(details.requester).toBe("main");
    expect(details.agents).toHaveLength(1);
    expect(details.agents?.[0]?.id).toBe("codex");
    expect(details.agents?.[0]?.name).toBe("Codex");
    expect(details.agents?.[0]?.configured).toBe(true);
    expect(details.agents?.[0]?.model).toBe("openai/gpt-5.5");
    expect(details.agents?.[0]?.agentRuntime?.id).toBe("codex");
    expect(details.agents?.[0]?.agentRuntime?.source).toBe("model");
  });

  it("returns requester as the only target when no subagent allowlist is configured", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [{ id: "main", default: true }, { id: "codex" }],
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;

    expect(details.requester).toBe("main");
    expect(details.allowAny).toBe(false);
    expect(details.agents).toHaveLength(1);
    expect(details.agents?.[0]?.id).toBe("main");
    expect(details.agents?.[0]?.configured).toBe(true);
  });

  it("ignores legacy env-forced plugin runtime selections", async () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "codex");
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;

    expect(details.agents).toHaveLength(1);
    expect(details.agents?.[0]?.id).toBe("main");
    expect(details.agents?.[0]?.agentRuntime?.id).toBe("codex");
    expect(details.agents?.[0]?.agentRuntime?.source).toBe("implicit");
  });

  it("ignores legacy per-agent runtime overrides", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          agentRuntime: { id: "auto" },
          subagents: { allowAgents: ["strict"] },
        },
        list: [
          { id: "main", default: true },
          { id: "strict", agentRuntime: { id: "codex" } },
        ],
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;

    expect(details.agents).toHaveLength(1);
    expect(details.agents?.[0]?.id).toBe("strict");
    expect(details.agents?.[0]?.agentRuntime?.id).toBe("codex");
    expect(details.agents?.[0]?.agentRuntime?.source).toBe("implicit");
  });
});
