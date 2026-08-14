import { describe, expect, it } from "vitest";
import {
  AgentSelectionRequiredError,
  listAgentEntries,
  resolveDefaultAgentId,
  resolveSystemAgentTargetAgentId,
} from "../../../agents/agent-scope-config.js";
import { materializeLegacyDefaultAgentRoles } from "../../../config/legacy.default-agent-roles.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import { resolveHeartbeatAgents } from "../../../infra/heartbeat-runner.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { resolveTalkSessionAgentId, resolveTalkTargetAgentId } from "../../../talk/agent-target.js";

function materializeDefaultAgentRoles(cfg: OpenClawConfig) {
  if (listAgentEntries(cfg).length < 2) {
    return { config: cfg, changes: [] };
  }
  const result = materializeLegacyDefaultAgentRoles(cfg, resolveDefaultAgentId(cfg));
  return { config: result.config, changes: result.insertedPaths.map((path) => path.join(".")) };
}

type SurfaceSnapshot = {
  channel: { agentId: string; sessionKey: string };
  heartbeat: string[];
  consult: string | null;
  voice: string;
  cron: string;
  cli: string;
};

function snapshotSurfaces(cfg: OpenClawConfig): SurfaceSnapshot {
  const channel = resolveAgentRoute({
    cfg,
    channel: "telegram",
    accountId: "work",
    peer: { kind: "direct", id: "user-1" },
  });
  const defaultAgentId = resolveDefaultAgentId(cfg);
  return {
    channel: { agentId: channel.agentId, sessionKey: channel.sessionKey },
    heartbeat: resolveHeartbeatAgents(cfg).map((entry) => entry.agentId),
    consult: (() => {
      try {
        return resolveSystemAgentTargetAgentId(cfg);
      } catch (error) {
        if (error instanceof AgentSelectionRequiredError) {
          return null;
        }
        throw error;
      }
    })(),
    voice: resolveTalkTargetAgentId(cfg),
    cron: resolveCronJobEffectiveAgentId({}, defaultAgentId),
    cli: defaultAgentId,
  };
}

const fixtures: Array<{ name: string; config: OpenClawConfig; materializes: boolean }> = [
  { name: "legacy single-agent", config: {}, materializes: false },
  {
    name: "explicit single-agent",
    config: {
      agents: { entries: { solo: { default: true } } },
      channels: { telegram: { enabled: true } },
      talk: { provider: "test" },
    },
    materializes: false,
  },
  {
    name: "multi-agent default with an unbound channel",
    config: {
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: { telegram: { enabled: true } },
    },
    materializes: true,
  },
  {
    name: "multi-agent fully bound",
    config: {
      agents: {
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
          authInheritance: { agentId: "ops" },
        },
        entries: { ops: { default: true }, research: {} },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
      channels: { telegram: { enabled: true } },
      talk: { agentId: "ops", provider: "test" },
    },
    materializes: false,
  },
];

describe("default agent role materialization", () => {
  it.each(fixtures)("preserves all ambient surface routing for $name", ({ config }) => {
    const before = snapshotSurfaces(config);
    const result = materializeDefaultAgentRoles(config);
    expect(snapshotSurfaces(result.config)).toEqual(
      before.consult === null ? { ...before, consult: resolveDefaultAgentId(config) } : before,
    );

    const second = materializeDefaultAgentRoles(result.config);
    expect(second.changes).toEqual([]);
    expect(second.config).toBe(result.config);
  });

  it.each(fixtures)("materializes only the expected $name fixture", ({ config, materializes }) => {
    const result = materializeDefaultAgentRoles(config);
    expect(result.changes.length > 0).toBe(materializes);
  });

  it("adds only uncovered channel-wide bindings and preserves narrower routes", () => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: {
        telegram: { enabled: true },
        discord: { enabled: true },
        slack: { enabled: false },
      },
      bindings: [
        { agentId: "research", match: { channel: "telegram", accountId: "work" } },
        { agentId: "research", match: { channel: "discord", accountId: "*" } },
      ],
    };
    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual([
      ...config.bindings!,
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
    ]);
    expect(
      resolveAgentRoute({
        cfg: result.config,
        channel: "telegram",
        accountId: "work",
        peer: { kind: "direct", id: "user-1" },
      }).agentId,
    ).toBe("research");
  });

  it("keeps all-agent and per-agent heartbeat enrollment unchanged", () => {
    const allAgents: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "1h" } },
        entries: { ops: { default: true }, research: {} },
      },
    };
    const perAgent: OpenClawConfig = {
      agents: {
        entries: {
          ops: { default: true },
          research: { heartbeat: { every: "1h" } },
        },
      },
    };
    expect(materializeDefaultAgentRoles(allAgents).config.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
    });
    expect(resolveHeartbeatAgents(materializeDefaultAgentRoles(allAgents).config)).toHaveLength(2);
    expect(
      materializeDefaultAgentRoles(perAgent).config.agents?.entries?.research?.heartbeat,
    ).toEqual({ every: "1h" });
    expect(resolveHeartbeatAgents(materializeDefaultAgentRoles(perAgent).config)).toEqual([
      { agentId: "research", heartbeat: { every: "1h" } },
    ]);
  });

  it("materializes absent Talk config but preserves malformed Talk input", () => {
    const base: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
    };
    expect(materializeDefaultAgentRoles(base).config.talk).toEqual({ agentId: "ops" });
    const malformed = { ...base, talk: "invalid" as never };
    expect(materializeDefaultAgentRoles(malformed).config.talk).toBe("invalid");
  });

  it("uses the Talk owner for unscoped aliases and explicit agent keys when present", () => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
      talk: { agentId: "research" },
    };
    expect(resolveTalkSessionAgentId(config, "main")).toBe("research");
    expect(resolveTalkSessionAgentId(config, "global")).toBe("research");
    expect(resolveTalkSessionAgentId(config, "agent:ops:main")).toBe("ops");
  });

  it("routes bare Talk sessions through the persisted fixed-store owner", () => {
    const config: OpenClawConfig = {
      talk: { agentId: "research" },
      session: { store: "/tmp/owned-shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(resolveTalkSessionAgentId(config, "incident-42")).toBe("ops");
  });

  it("preserves malformed bindings and agent-default blocks for validation", () => {
    const base = {
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: { telegram: { enabled: true } },
    } satisfies OpenClawConfig;
    const malformedBindings = { ...base, bindings: { bad: true } as never };
    expect(materializeDefaultAgentRoles(malformedBindings).config.bindings).toEqual({ bad: true });
    const malformedDefaults = {
      ...base,
      agents: { ...base.agents, defaults: null as never },
    };
    expect(materializeDefaultAgentRoles(malformedDefaults).config.agents?.defaults).toBeNull();
    const malformedSystemAgent = {
      ...base,
      agents: { ...base.agents, defaults: { systemAgent: null as never } },
      talk: { agentId: " " },
    };
    const preserved = materializeDefaultAgentRoles(malformedSystemAgent).config;
    expect(preserved.agents?.defaults?.systemAgent).toBeNull();
    expect(preserved.talk?.agentId).toBe(" ");
  });
});
