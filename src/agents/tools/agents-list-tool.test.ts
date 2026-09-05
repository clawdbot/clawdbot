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
    description?: string;
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
      '{ agents: Array<{ configured: boolean; id: string; agentRuntime?: { id: string; source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session" | "session-key" }; description?: string; model?: string; name?: string }>; allowAny: boolean; requester: string }',
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

  it("returns trimmed descriptions only for allowed agents and omits blanks", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        entries: {
          main: { subagents: { allowAgents: ["research", "blank"] } },
          research: { name: "Research", description: "  Finds and synthesizes evidence  " },
          blank: { description: "   " },
          excluded: { description: "Excluded agent description" },
        },
      },
    } satisfies OpenClawConfig);

    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const details = result.details as AgentListDetails;
    expect(details.agents?.map((agent) => agent.id)).toEqual(["blank", "research"]);
    expect(details.agents?.find((agent) => agent.id === "research")).toMatchObject({
      name: "Research",
      description: "Finds and synthesizes evidence",
    });
    expect(details.agents?.find((agent) => agent.id === "blank")).not.toHaveProperty("description");
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
    expect(JSON.stringify(result)).not.toContain("Excluded agent description");
  });

  it("bounds each description without splitting a surrogate pair", async () => {
    loadConfigMock.mockReturnValue({
      agents: { entries: { main: { description: `${"a".repeat(511)}🚀tail` } } },
    } satisfies OpenClawConfig);
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    expect((result.details as AgentListDetails).agents?.[0]?.description).toBe(
      `${"a".repeat(511)}…`,
    );
  });

  it.each([
    { label: "ASCII", description: "a".repeat(600), count: 10, retained: 8, units: 1 },
    { label: "CJK", description: "漢".repeat(512), count: 4, retained: 2, units: 4 },
  ])(
    "bounds the aggregate $label description budget without dropping agents",
    async ({ description, count, retained, units }) => {
      const ids = Array.from({ length: count }, (_, index) => `agent-${index}`);
      loadConfigMock.mockReturnValue({
        agents: {
          entries: {
            main: { subagents: { allowAgents: ["*"] } },
            ...Object.fromEntries(ids.map((id) => [id, { description }])),
          },
        },
      } satisfies OpenClawConfig);
      const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
        "call",
        {},
      );
      const agents = (result.details as AgentListDetails).agents;
      expect(agents?.map((agent) => agent.id)).toEqual(["main", ...ids]);
      const descriptions =
        agents?.flatMap((agent) => (agent.description ? [agent.description] : [])) ?? [];
      expect(descriptions).toHaveLength(retained);
      expect(descriptions.reduce((total, text) => total + text.length * units, 0)).toBe(4096);
      expect(
        agents?.slice(retained + 1).every((agent) => !Object.hasOwn(agent, "description")),
      ).toBe(true);
    },
  );

  it("fits a mixed-script final description into the remaining aggregate budget", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        entries: {
          main: { description: "a".repeat(505), subagents: { allowAgents: ["*"] } },
          ...Object.fromEntries(
            Array.from({ length: 7 }, (_, index) => [
              `agent-${index}`,
              { description: "a".repeat(512) },
            ]),
          ),
          final: { description: "漢🚀more" },
          later: { description: "Omitted after budget exhaustion" },
        },
      },
    } satisfies OpenClawConfig);
    const result = await createAgentsListTool({ agentSessionKey: "agent:main:main" }).execute(
      "call",
      {},
    );
    const agents = (result.details as AgentListDetails).agents;
    expect(agents?.find((agent) => agent.id === "final")?.description).toBe("漢🚀…");
    expect(agents?.find((agent) => agent.id === "later")).not.toHaveProperty("description");
    expect(agents?.[0]?.id).toBe("main");
  });

  it("resolves configured model aliases to the canonical model identity", async () => {
    // Routing aliases are transport-level names; the tool must publish the
    // resolved model that will actually run so spawn decisions see one identity.
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          model: {
            primary: "clawrouter/openai/gpt-5.6",
            fallbacks: ["openai/gpt-5.6-luna"],
          },
          models: {
            "openai/gpt-5.6-sol": {
              alias: "clawrouter/openai/gpt-5.6",
              agentRuntime: { id: "codex" },
            },
          },
          subagents: { allowAgents: ["main"] },
        },
        list: [{ id: "main", default: true }],
      },
    } as unknown as OpenClawConfig);

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
