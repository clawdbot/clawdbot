// agents_list tests cover subagent discovery, runtime metadata, and legacy
// runtime override handling.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as providerModelNormalizationRuntime from "../provider-model-normalization.runtime.js";
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

  it.each([
    {
      name: "default-provider",
      modelRef: "openai/gpt-5.6-sol",
      alias: "clawrouter/openai/gpt-5.6",
      runtimeId: "codex",
    },
    {
      name: "custom-provider",
      modelRef: "fixture-inventory/canonical-model",
      alias: "inventory-alias",
      runtimeId: "openclaw",
    },
  ] as const)(
    "resolves $name aliases without executing provider model normalizers",
    async ({ modelRef, alias, runtimeId }) => {
      const normalizeModel = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockReturnValue("runtime-only-model");
      onTestFinished(() => normalizeModel.mockRestore());
      // Routing aliases are transport-level names; the tool must publish the
      // resolved model that will actually run so spawn decisions see one identity.
      loadConfigMock.mockReturnValue({
        agents: {
          defaults: {
            model: {
              primary: alias,
              fallbacks: ["openai/gpt-5.6-luna"],
            },
            models: {
              [modelRef]: {
                alias,
                agentRuntime: { id: runtimeId },
              },
            },
            subagents: { allowAgents: ["main"] },
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
            model: modelRef,
            agentRuntime: { id: runtimeId, source: "model" },
          },
        ],
      });
      expect(normalizeModel).not.toHaveBeenCalled();
    },
  );

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
          model: "openai/gpt-5.6-sol",
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
          model: "openai/gpt-5.6-sol",
          agentRuntime: { id: "codex", source: "implicit" },
        },
      ],
    });
  });

  it("uses the persisted fixed-store owner for a bare requester key", async () => {
    loadConfigMock.mockReturnValue({
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    });

    const result = await createAgentsListTool({ agentSessionKey: "global" }).execute("call", {});

    expect(result.details).toMatchObject({
      requester: "ops",
      agents: [{ id: "ops", configured: true }],
    });
  });
});
