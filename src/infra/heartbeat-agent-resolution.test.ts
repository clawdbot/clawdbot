import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "../cron/heartbeat-monitor.js";
import { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
import { isHeartbeatOwnerUnresolved, resolveHeartbeatAgents } from "./heartbeat-config.js";
import {
  isHeartbeatEnabledForAgent,
  resolveHeartbeatSummaryForAgent,
} from "./heartbeat-summary.js";

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
    { name: "system owner", cfg: systemOwnedConfig, expectedAgentIds: ["ops"] },
    {
      name: "explicit heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: {} },
          defaults: { heartbeat: { agentId: "ops" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "legacy default marker",
      cfg: {
        agents: { entries: { main: { default: true }, ops: {} } },
      } as OpenClawConfig,
      expectedAgentIds: ["main"],
    },
    {
      name: "sole agent",
      cfg: { agents: { ownership: "explicit", entries: { solo: {} } } } as OpenClawConfig,
      expectedAgentIds: ["solo"],
    },
    {
      name: "per-agent heartbeat entries",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
    },
    {
      name: "per-agent enrollment takes precedence over the default heartbeat owner",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { heartbeat: { every: "30m" } } },
          defaults: { heartbeat: { agentId: "main" } },
        },
      } as OpenClawConfig,
      expectedAgentIds: ["ops"],
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
      expectedAgentIds: ["main", "ops"],
    },
  ])("enrolls exactly the runnable agents for the $name config", ({ cfg, expectedAgentIds }) => {
    const agents = resolveHeartbeatAgents(cfg);
    expect(agents.map((agent) => agent.agentId)).toEqual(expectedAgentIds);
    for (const agentId of Object.keys(cfg.agents?.entries ?? {})) {
      expect(isHeartbeatEnabledForAgent(cfg, agentId)).toBe(expectedAgentIds.includes(agentId));
    }
  });
});

describe("per-agent heartbeat opt-out", () => {
  const disabledCodexConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, codex: { heartbeat: { every: "0m" } }, dorami: {} },
      defaults: {
        heartbeat: { every: "55m" },
        systemAgent: { agentId: "main" },
      },
    },
  } as OpenClawConfig;

  it("disables only the opted-out agent and keeps siblings on the inherited cadence", () => {
    expect(resolveHeartbeatAgents(disabledCodexConfig).map((agent) => agent.agentId)).toEqual([
      "main",
      "codex",
      "dorami",
    ]);
    for (const agentId of ["main", "dorami"]) {
      expect(resolveHeartbeatSummaryForAgent(disabledCodexConfig, agentId)).toMatchObject({
        enabled: true,
        every: "55m",
      });
    }
    expect(resolveHeartbeatSummaryForAgent(disabledCodexConfig, "codex")).toMatchObject({
      enabled: false,
      every: "disabled",
      everyMs: null,
    });
  });

  it("keeps the monitor row of the opted-out agent while its siblings keep theirs", () => {
    const plan = resolveHeartbeatMonitorPlan(disabledCodexConfig, []);
    expect(
      plan.changes.map((change) => ({
        kind: change.kind,
        agentId: change.agentId,
        enabled: change.kind === "create" ? change.input.enabled : undefined,
      })),
    ).toEqual([
      { kind: "create", agentId: "main", enabled: true },
      { kind: "create", agentId: "codex", enabled: false },
      { kind: "create", agentId: "dorami", enabled: true },
    ]);
  });

  it("still enrolls only opted-in agents when one per-agent block sets a cadence", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: {
          main: {},
          codex: { heartbeat: { every: "0m" } },
          ops: { heartbeat: { every: "1h" } },
        },
        defaults: { heartbeat: { every: "55m" } },
      },
    } as OpenClawConfig;
    expect(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId)).toEqual(["codex", "ops"]);
    expect(isHeartbeatEnabledForAgent(cfg, "main")).toBe(false);
  });

  it("keeps the ambient owner enrolled when the only heartbeat block is an opt-out", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, codex: { heartbeat: { every: "0m" } } },
        defaults: { systemAgent: { agentId: "main" } },
      },
    } as OpenClawConfig;
    expect(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId)).toEqual(["main", "codex"]);
    expect(resolveHeartbeatSummaryForAgent(cfg, "main").enabled).toBe(true);
    expect(resolveHeartbeatSummaryForAgent(cfg, "codex").enabled).toBe(false);
  });
});
