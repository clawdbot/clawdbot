import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveSessionAgentId,
  resolveSessionAgentIdStrict,
  resolveSessionAgentIds,
  resolveSessionAgentIdsStrict,
} from "./agent-scope-runtime.js";

describe("agent-scope-runtime compatibility", () => {
  const config = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "beta" } },
      entries: { main: {}, beta: {} },
    },
  } satisfies OpenClawConfig;

  it("resolves the configured system agent for ownerless shipped calls", () => {
    expect(resolveSessionAgentIds({ config })).toEqual({
      defaultAgentId: "beta",
      sessionAgentId: "beta",
    });
    expect(resolveSessionAgentId({ config })).toBe("beta");
  });

  it("keeps strict resolution ownerless", () => {
    expect(() => resolveSessionAgentIdsStrict({ config })).toThrow(AgentSelectionRequiredError);
    expect(() => resolveSessionAgentIdStrict({ config })).toThrow(AgentSelectionRequiredError);
  });

  it.each([
    {
      name: "explicit agent",
      params: { config, agentId: "main" },
      expected: "main",
    },
    {
      name: "prepared fallback agent",
      params: { config, fallbackAgentId: "main" },
      expected: "main",
    },
    {
      name: "agent-scoped session key",
      params: { config, sessionKey: "agent:main:main" },
      expected: "main",
    },
    {
      name: "persisted fixed-store owner",
      params: {
        config: {
          ...config,
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              sessionStore: { agentId: "main" },
            },
          },
        },
        sessionKey: "global",
      },
      expected: "main",
    },
  ])("does not override $name", ({ params, expected }) => {
    expect(resolveSessionAgentIds(params).sessionAgentId).toBe(expected);
  });

  it.each([
    {
      name: "conflicting explicit and agent-scoped owners",
      params: { config, agentId: "beta", sessionKey: "agent:main:main" },
    },
    {
      name: "conflicting explicit and persisted owners",
      params: {
        config: {
          ...config,
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              sessionStore: { agentId: "main" },
            },
          },
        },
        agentId: "beta",
        sessionKey: "global",
      },
    },
    {
      name: "retired persisted owner",
      params: {
        config: {
          ...config,
          session: { store: "/tmp/shared.sqlite" },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              sessionStore: { agentId: "retired" },
            },
          },
        },
        sessionKey: "global",
      },
    },
  ])("preserves $name failures", ({ params }) => {
    expect(() => resolveSessionAgentIds(params)).toThrow(AgentSelectionRequiredError);
  });
});
