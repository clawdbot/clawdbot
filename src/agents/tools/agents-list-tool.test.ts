import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const loadConfigMock = vi.fn<() => OpenClawConfig>();

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
            agentRuntime: { id: "codex" },
          },
        ],
      },
    } satisfies OpenClawConfig);

    const { createAgentsListTool } = await import("./agents-list-tool.js");
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );

    expect(result.details).toMatchObject({
      requester: "main",
      agents: [
        {
          id: "codex",
          name: "Codex",
          configured: true,
          model: "openai/gpt-5.5",
          agentRuntime: { id: "codex", source: "agent" },
        },
      ],
    });
  });

  it("returns requester as the only target when no subagent allowlist is configured", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [{ id: "main", default: true }, { id: "codex" }],
      },
    } satisfies OpenClawConfig);

    const { createAgentsListTool } = await import("./agents-list-tool.js");
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );

    expect(result.details).toMatchObject({
      requester: "main",
      allowAny: false,
      agents: [
        {
          id: "main",
          configured: true,
        },
      ],
    });
  });

  it("reports env-forced plugin runtime selections", async () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "codex");
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig);

    const { createAgentsListTool } = await import("./agents-list-tool.js");
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );

    expect(result.details).toMatchObject({
      agents: [
        {
          id: "main",
          agentRuntime: { id: "codex", source: "env" },
        },
      ],
    });
  });

  it("reports per-agent runtime overrides", async () => {
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

    const { createAgentsListTool } = await import("./agents-list-tool.js");
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );

    expect(result.details).toMatchObject({
      agents: [
        {
          id: "strict",
          agentRuntime: { id: "codex", source: "agent" },
        },
      ],
    });
  });
});
