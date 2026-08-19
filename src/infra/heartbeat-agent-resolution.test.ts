import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import { isHeartbeatOwnerUnresolved, resolveHeartbeatAgents } from "./heartbeat-runner-config.js";
import { isHeartbeatEnabledForAgent } from "./heartbeat-summary.js";

describe("tryResolveAmbientHeartbeatAgentId", () => {
  it.each([
    {
      name: "explicit heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "main" },
          },
        },
      } as OpenClawConfig,
      expected: "ops",
    },
    {
      name: "legacy default marker before the system owner",
      cfg: {
        agents: {
          entries: { legacy: { default: true }, ops: {} },
          defaults: { systemAgent: { agentId: "ops" } },
        },
      } as OpenClawConfig,
      expected: "legacy",
    },
    {
      name: "system owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { systemAgent: { agentId: "ops" } },
        },
      } as OpenClawConfig,
      expected: "ops",
    },
    {
      name: "sole agent",
      cfg: {
        agents: { ownership: "explicit", entries: { solo: {} } },
      } as OpenClawConfig,
      expected: "solo",
    },
    {
      name: "ownerless explicit multi-agent roster",
      cfg: {
        agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      } as OpenClawConfig,
      expected: undefined,
    },
  ])("resolves the $name", ({ cfg, expected }) => {
    expect(tryResolveAmbientHeartbeatAgentId(cfg)).toBe(expected);
  });
});

describe("resolveHeartbeatAgents", () => {
  const systemOwnedConfig = {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, main: {} },
      defaults: { systemAgent: { agentId: "ops" } },
    },
  } as OpenClawConfig;
  const ownerlessConfig = {
    agents: { ownership: "explicit", entries: { ops: {}, main: {} } },
  } as OpenClawConfig;

  it("enrolls the system agent when ambient heartbeat config is absent", () => {
    expect(resolveHeartbeatAgents(systemOwnedConfig)).toEqual([
      { agentId: "ops", heartbeat: undefined },
    ]);
    expect(isHeartbeatEnabledForAgent(systemOwnedConfig, "ops")).toBe(true);
    expect(isHeartbeatEnabledForAgent(systemOwnedConfig, "main")).toBe(false);
    expect(isHeartbeatOwnerUnresolved(systemOwnedConfig)).toBe(false);
  });

  it("disables ambient heartbeats when an explicit multi-agent roster has no owner", () => {
    expect(resolveHeartbeatAgents(ownerlessConfig)).toEqual([]);
    expect(isHeartbeatEnabledForAgent(ownerlessConfig)).toBe(false);
    expect(isHeartbeatEnabledForAgent(ownerlessConfig, "ops")).toBe(false);
    expect(isHeartbeatOwnerUnresolved(ownerlessConfig)).toBe(true);
  });

  it.each([
    { name: "system owner", cfg: systemOwnedConfig },
    {
      name: "explicit heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { agentId: "ops" } },
        },
      } as OpenClawConfig,
    },
    {
      name: "legacy default marker",
      cfg: {
        agents: { entries: { main: { default: true }, ops: {} } },
      } as OpenClawConfig,
    },
    {
      name: "sole agent",
      cfg: { agents: { ownership: "explicit", entries: { solo: {} } } } as OpenClawConfig,
    },
    {
      name: "per-agent heartbeat entries",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
        },
      } as OpenClawConfig,
    },
    {
      name: "broadcast heartbeat defaults",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { every: "30m" } },
        },
      } as OpenClawConfig,
    },
  ])("keeps every enrolled agent runnable for the $name config", ({ cfg }) => {
    const agents = resolveHeartbeatAgents(cfg);
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(isHeartbeatEnabledForAgent(cfg, agent.agentId)).toBe(true);
    }
  });
});
