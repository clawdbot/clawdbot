// Verifies Swarm tools remain absent by default and appear only for gated runs.
import { describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function toolNames(options: NonNullable<Parameters<typeof createOpenClawTools>[0]>) {
  return createOpenClawTools({
    disableMessageTool: true,
    disablePluginTools: true,
    wrapBeforeToolCallHook: false,
    ...options,
  }).map((tool) => tool.name);
}

describe("openclaw-tools Swarm gating", () => {
  it("registers agents_wait only when tools.swarm is enabled", () => {
    const base = { agentSessionKey: "agent:main:main" };
    expect(toolNames(base)).not.toContain("agents_wait");
    expect(toolNames({ ...base, config: { tools: { swarm: true } } })).toContain("agents_wait");
  });

  it("uses the effective requester agent override for the agents_wait gate", () => {
    const base = {
      agentSessionKey: "agent:main:main",
      requesterAgentIdOverride: "worker",
    };
    expect(
      toolNames({
        ...base,
        config: {
          tools: { swarm: false },
          agents: { list: [{ id: "worker", tools: { swarm: true } }] },
        },
      }),
    ).toContain("agents_wait");
    expect(
      toolNames({
        ...base,
        config: {
          tools: { swarm: true },
          agents: { list: [{ id: "worker", tools: { swarm: false } }] },
        },
      }),
    ).not.toContain("agents_wait");
  });

  it("injects structured_output only for schema-backed collector runs", () => {
    const base = {
      agentSessionKey: "agent:worker:subagent:child",
      runId: "collector-run",
      config: { tools: { swarm: true } },
    };
    expect(toolNames({ ...base, swarmCollector: true })).not.toContain("structured_output");
    expect(
      toolNames({
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
      config: { tools: { allow: ["read"], swarm: true } },
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
      config: { tools: { swarm: true } },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("message");
  });

  it("omits interactive and pausing tools for non-interactive collector runs", () => {
    const names = createOpenClawCodingTools({
      sessionKey: "agent:worker:main",
      runId: "collector-run",
      config: { tools: { swarm: true } },
      swarmCollector: true,
    }).map((tool) => tool.name);

    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("sessions_send");
    expect(names).not.toContain("sessions_yield");
  });
});
