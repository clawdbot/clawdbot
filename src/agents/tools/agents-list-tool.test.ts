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
          agentRuntime: { id: "pi", fallback: "pi" },
          subagents: { allowAgents: ["codex"] },
        },
        list: [
          { id: "main", default: true },
          {
            id: "codex",
            name: "Codex",
            model: "openai/gpt-5.5",
            agentRuntime: { id: "codex", fallback: "none" },
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
          agentRuntime: { id: "codex", fallback: "none", source: "agent" },
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

  it("marks OPENCLAW_AGENT_RUNTIME and fallback env overrides as effective", async () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "codex");
    vi.stubEnv("OPENCLAW_AGENT_HARNESS_FALLBACK", "pi");
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          agentRuntime: { fallback: "none" },
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
          agentRuntime: { id: "codex", fallback: "pi", source: "env" },
        },
      ],
    });
  });

  it("preserves agent fallback-only overrides while inheriting default runtime id", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          agentRuntime: { id: "auto", fallback: "pi" },
          subagents: { allowAgents: ["strict"] },
        },
        list: [
          { id: "main", default: true },
          { id: "strict", agentRuntime: { fallback: "none" } },
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
          agentRuntime: { id: "auto", fallback: "none", source: "agent" },
        },
      ],
    });
  });
});
