// agents_list tests cover subagent discovery, runtime metadata, and legacy
// runtime override handling.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
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
          agentRuntime: { id: "openclaw" },
          subagents: { allowAgents: ["codex"] },
        },
        list: [
          { id: "main", default: true },
          {
            id: "codex",
            name: "Codex",
            model: "openai/gpt-5.5",
            agentRuntime: { id: "openclaw" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig);

    const tool = createAgentsListTool({ agentSessionKey: "agent:main:main" });
    expect(tool.outputSchema).toMatchObject({
      type: "object",
      required: ["requester", "allowAny", "agents"],
    });
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ agents: Array<{ configured: boolean; id: string; agentRuntime?: { id: string; source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session" | "session-key" }; model?: string; name?: string }>; allowAny: boolean; requester: string }',
    );
    const result = await tool.execute("call", {});
    const details = result.details as AgentListDetails;

    expect(details).toStrictEqual({
      requester: "main",
      allowAny: false,
      agents: [
        {
          id: "codex",
          name: "Codex",
          configured: true,
          model: "openai/gpt-5.5",
          agentRuntime: { id: "codex", source: "model" },
        },
      ],
    });
  });

  it("does not advertise stale allowlist-only targets as spawnable agents", async () => {
    // Allowlist entries are permissions, not agent definitions; stale ids should
    // not be presented as runnable subagents.
    loadConfigMock.mockReturnValue({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            subagents: { allowAgents: ["stale"] },
          },
        ],
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;

    expect(details).toStrictEqual({
      requester: "main",
      allowAny: false,
      agents: [],
    });
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

    expect(details).toStrictEqual({
      requester: "main",
      allowAny: false,
      agents: [
        {
          id: "main",
          name: undefined,
          configured: true,
          model: undefined,
          agentRuntime: { id: "codex", source: "implicit" },
        },
      ],
    });
  });

  it("uses the implicit default agent as a configured target", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          subagents: { allowAgents: ["main"] },
        },
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;

    expect(details).toStrictEqual({
      requester: "main",
      allowAny: false,
      agents: [
        {
          id: "main",
          name: undefined,
          configured: true,
          model: undefined,
          agentRuntime: { id: "codex", source: "implicit" },
        },
      ],
    });
  });

  it("ignores legacy env-forced plugin runtime selections", async () => {
    // Runtime selection now comes from config/model routing, not a process-wide
    // legacy env override.
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

    expect(details).toStrictEqual({
      requester: "main",
      allowAny: false,
      agents: [
        {
          id: "main",
          name: undefined,
          configured: true,
          model: "openai/gpt-5.5",
          agentRuntime: { id: "codex", source: "implicit" },
        },
      ],
    });
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

    expect(details).toStrictEqual({
      requester: "main",
      allowAny: false,
      agents: [
        {
          id: "strict",
          name: undefined,
          configured: true,
          model: undefined,
          agentRuntime: { id: "codex", source: "implicit" },
        },
      ],
    });
  });
});
