import { describe, expect, it, vi } from "vitest";
import { setEmbeddedMode } from "../infra/embedded-mode.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

function createSwarmTools(options: NonNullable<Parameters<typeof createOpenClawTools>[0]>) {
  const config = options.config ?? {};
  return createOpenClawTools({
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
    config: {
      ...config,
      agents: config.agents ?? { entries: { main: { default: true } } },
    },
  });
}

function createSwarmToolNames(options: NonNullable<Parameters<typeof createOpenClawTools>[0]>) {
  return createSwarmTools(options).map((tool) => tool.name);
}

describe("Swarm registration", () => {
  it.each([
    { swarm: undefined, enabled: true },
    { swarm: true, enabled: true },
    { swarm: false, enabled: false },
    { swarm: { enabled: false }, enabled: false },
  ])("registers agents_wait with swarm=$swarm: $enabled", ({ swarm, enabled }) => {
    const names = createSwarmToolNames({
      agentSessionKey: "agent:main:main",
      config: { tools: { swarm } },
    });
    expect(names.includes("agents_wait")).toBe(enabled);
  });

  it.each([
    { profile: "full", spawn: true, wait: true },
    { profile: "coding", spawn: true, wait: true },
    { profile: "messaging", spawn: true, wait: false },
    { profile: "minimal", spawn: false, wait: false },
  ] as const)(
    "keeps default Swarm within the $profile tool profile",
    ({ profile, spawn, wait }) => {
      const tools = createOpenClawCodingTools({
        sessionKey: "agent:main:main",
        config: {
          agents: { entries: { main: { default: true } } },
          tools: { profile },
        },
      });
      const names = new Set(tools.map((tool) => tool.name));
      expect(names.has("sessions_spawn")).toBe(spawn);
      expect(names.has("agents_wait")).toBe(wait);
      if (spawn) {
        const spawnTool = tools.find((tool) => tool.name === "sessions_spawn");
        expect(spawnTool?.parameters).toHaveProperty("properties.fastMode");
        for (const field of ["collect", "outputSchema", "groupId"]) {
          if (wait) {
            expect(spawnTool?.parameters).toHaveProperty(`properties.${field}`);
          } else {
            expect(spawnTool?.parameters).not.toHaveProperty(`properties.${field}`);
          }
        }
        if (!wait) {
          expect(JSON.stringify(spawnTool?.parameters)).not.toContain("collect=true");
        }
      }
    },
  );

  it("uses the effective requester agent override for the agents_wait gate", () => {
    const base = {
      agentSessionKey: "agent:worker:main",
      requesterAgentIdOverride: "worker",
    };
    expect(
      createSwarmToolNames({
        ...base,
        config: {
          tools: { swarm: false },
          agents: {
            entries: { main: {}, worker: { tools: { swarm: true } } },
          },
        },
      }),
    ).toContain("agents_wait");
    expect(
      createSwarmToolNames({
        ...base,
        config: {
          tools: { swarm: true },
          agents: {
            entries: { main: {}, worker: { tools: { swarm: false } } },
          },
        },
      }),
    ).not.toContain("agents_wait");
  });

  it("advertises sessions_spawn from agents_wait only when spawn is available", () => {
    setEmbeddedMode(true);
    try {
      const createTools = (allowGatewaySubagentBinding: boolean) =>
        createSwarmTools({
          agentSessionKey: "agent:main:main",
          allowGatewaySubagentBinding,
          config: { tools: { swarm: true } },
        });
      const withoutSpawn = applyToolAvailabilityDescriptions(createTools(false));
      const withSpawn = applyToolAvailabilityDescriptions(createTools(true));

      expect(withoutSpawn.map((tool) => tool.name)).not.toContain("sessions_spawn");
      expect(withoutSpawn.find((tool) => tool.name === "agents_wait")).toMatchObject({
        description: expect.not.stringContaining("sessions_spawn"),
      });
      expect(withSpawn.map((tool) => tool.name)).toContain("sessions_spawn");
      expect(withSpawn.find((tool) => tool.name === "agents_wait")).toMatchObject({
        description: expect.stringContaining("sessions_spawn"),
      });
    } finally {
      setEmbeddedMode(false);
    }
  });

  it("injects structured_output only for schema-backed collector runs", () => {
    const base = {
      agentSessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: { tools: { swarm: true } },
    };
    expect(createSwarmToolNames({ ...base, swarmCollector: true })).not.toContain(
      "structured_output",
    );
    expect(
      createSwarmToolNames({
        ...base,
        swarmCollector: true,
        swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    ).toContain("structured_output");
  });

  it("keeps structured_output through restrictive child tool policy", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { allow: ["read"], swarm: true },
      },
      swarmCollector: true,
      swarmOutputSchema: { type: "object", properties: { answer: { type: "string" } } },
    }).map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).toContain("structured_output");
    expect(names).not.toContain("exec");
  });

  it("omits the message tool for collector runs by invariant", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("message");
  });

  it("omits interactive and pausing tools for non-interactive collector runs", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:main",
      runId: "collector-run",
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { swarm: true },
      },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("sessions_send");
    expect(names).not.toContain("sessions_yield");
  });
});
