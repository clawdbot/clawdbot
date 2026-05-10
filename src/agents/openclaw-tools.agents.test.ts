import { describe, expect, it, vi } from "vitest";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";

let configOverride: ReturnType<(typeof import("../config/config.js"))["getRuntimeConfig"]> = {
  session: createPerSenderSessionConfig(),
};

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => configOverride,
    resolveGatewayPort: () => 18789,
  };
});

describe("agents_list", () => {
  type AgentConfig = NonNullable<NonNullable<typeof configOverride.agents>["list"]>[number];

  function setConfigWithAgentList(agentList: AgentConfig[]) {
    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        list: agentList,
      },
    };
  }

  function createTool() {
    return createAgentsListTool({
      agentSessionKey: "main",
    });
  }

  function readAgentList(result: unknown) {
    return (result as { details?: { agents?: Array<{ id: string; configured?: boolean }> } })
      .details?.agents;
  }

  it("defaults to the requester agent only", async () => {
    configOverride = {
      session: createPerSenderSessionConfig(),
    };
    const tool = createTool();
    const result = await tool.execute("call1", {});
    const details = result.details as { requester?: string; allowAny?: boolean };
    expect(details.requester).toBe("main");
    expect(details.allowAny).toBe(false);
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main"]);
  });

  it("includes configured allowlisted targets", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        name: "Main",
        subagents: {
          allowAgents: ["research"],
        },
      },
      {
        id: "research",
        name: "Research",
      },
    ]);

    const tool = createTool();
    const result = await tool.execute("call2", {});
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["research"]);
  });

  it("falls back to default allowlist when the requester agent omits allowAgents", async () => {
    configOverride = {
      session: createPerSenderSessionConfig(),
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["research"],
          },
        },
        list: [
          {
            id: "main",
            name: "Main",
          },
          {
            id: "research",
            name: "Research",
          },
        ],
      },
    };

    const tool = createTool();
    const result = await tool.execute("call2b", {});
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["research"]);
  });

  it("returns configured agents when allowlist is *", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        subagents: {
          allowAgents: ["*"],
        },
      },
      {
        id: "research",
        name: "Research",
      },
      {
        id: "coder",
        name: "Coder",
      },
    ]);

    const tool = createTool();
    const result = await tool.execute("call3", {});
    const details = result.details as { allowAny?: boolean };
    expect(details.allowAny).toBe(true);
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["main", "coder", "research"]);
  });

  it("marks allowlisted-but-unconfigured agents", async () => {
    setConfigWithAgentList([
      {
        id: "main",
        subagents: {
          allowAgents: ["research"],
        },
      },
    ]);

    const tool = createTool();
    const result = await tool.execute("call4", {});
    const agents = readAgentList(result);
    expect(agents?.map((agent) => agent.id)).toEqual(["research"]);
    const research = agents?.find((agent) => agent.id === "research");
    expect(research?.configured).toBe(false);
  });
});
