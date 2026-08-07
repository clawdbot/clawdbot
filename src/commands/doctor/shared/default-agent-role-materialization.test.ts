import { describe, expect, it } from "vitest";
import { resolveDefaultAgentId } from "../../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import { resolveHeartbeatAgents } from "../../../infra/heartbeat-runner.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { resolveSystemAgentTargetAgentId } from "../../../system-agent/inference-route.js";
import { resolveTalkSessionAgentId, resolveTalkTargetAgentId } from "../../../talk/agent-target.js";
import { materializeDefaultAgentRoles } from "./default-agent-role-materialization.js";

type SurfaceSnapshot = {
  channel: { agentId: string; sessionKey: string };
  heartbeat: string[];
  consult: string;
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
    consult: resolveSystemAgentTargetAgentId(cfg),
    voice: resolveTalkTargetAgentId(cfg),
    cron: resolveCronJobEffectiveAgentId({}, defaultAgentId),
    cli: defaultAgentId,
  };
}

const fixtures: Array<{ name: string; config: OpenClawConfig; materializes: boolean }> = [
  {
    name: "legacy single-agent",
    config: {},
    materializes: false,
  },
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
      agents: {
        entries: {
          ops: { default: true },
          research: {},
        },
      },
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
        },
        entries: {
          ops: { default: true },
          research: {},
        },
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
    expect(snapshotSurfaces(result.config)).toEqual(before);

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
    const result = materializeDefaultAgentRoles(malformed);
    expect(result.config.talk).toBe("invalid");
    expect(result.changes).not.toContain('Assigned ambient Talk sessions to agent "ops".');
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

  it("skips channel-wide materialization when a unique literal default-agent binding collides with env templates in restoreEnvVarRefs", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { agentId: "main" },
          systemAgent: { agentId: "main" },
        },
        entries: { main: { default: true }, group: {} },
      },
      channels: {
        telegram: { enabled: true },
        whatsapp: { enabled: true },
      },
      // One literal main-route + env-template peer id is the trip-prone shape:
      // restoreEnvVarRefs would find a unique authored `agentId: "main"` identity
      // and reject the append because the new sibling doubles the incoming count.
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "direct", id: "${TELEGRAM_OWNER_ID}" } },
        },
        { agentId: "group", match: { channel: "telegram", peer: { kind: "group", id: "-1001" } } },
      ],
      talk: { agentId: "main", provider: "test" },
    };

    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual(config.bindings);
    expect(result.changes).toEqual([
      "Skipped telegram, whatsapp: identity-collision guard against main would trip EnvRefArrayMutationError during write.",
    ]);
  });

  it("still materializes sibling channels when an env-bearing binding resolves to the default agent without uniqueness tripping the matcher", () => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: {
        telegram: { enabled: true },
        slack: { enabled: true },
        whatsapp: { enabled: true },
      },
      // Two env-bearing bindings on `slack` whose `agentId` resolves to
      // "ops" after env substitution. Identity path detection skips
      // env-bearing `agentId` values, so the matcher never sees a unique
      // literal `agentId: "ops"` authored binding and the new sibling
      // cannot collide. The per-channel env-ref skip keeps slack excluded
      // while telegram and whatsapp are still materialized.
      bindings: [
        { agentId: "${OPS_AGENT_ID}", match: { channel: "slack", accountId: "work" } },
        { agentId: "${OPS_AGENT_ID}", match: { channel: "slack", accountId: "personal" } },
      ],
    };
    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual([
      ...config.bindings!,
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
      { agentId: "ops", match: { channel: "whatsapp", accountId: "*" } },
    ]);
    expect(result.changes).toContain(
      'Bound telegram, whatsapp unbound account routing to agent "ops".',
    );
    expect(result.changes).toContain(
      "Skipped slack: existing binding uses an environment reference.",
    );
  });

  it("materializes sibling channels when multiple literal default-agent bindings already exist", () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true }, group: {} } },
      channels: {
        telegram: { enabled: true },
        slack: { enabled: true },
        whatsapp: { enabled: true },
      },
      // Two literal `agentId: "main"` bindings on telegram + an env-template
      // binding on a different channel. authoredCount for `agentId: "main"`
      // is 2, so the matcher's identity path is skipped (authoredCount !== 1)
      // and no append can collide. Doctor must still materialize the
      // channel-wide default for each unbound channel.
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "direct", id: "owner-1" } },
        },
        {
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "direct", id: "owner-2" } },
        },
        {
          agentId: "group",
          match: { channel: "slack", peer: { kind: "group", id: "${SLACK_GROUP_ID}" } },
        },
      ],
    };
    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual([
      ...config.bindings!,
      { agentId: "main", match: { channel: "telegram", accountId: "*" } },
      { agentId: "main", match: { channel: "whatsapp", accountId: "*" } },
    ]);
  });

  it("uses the resolved-only heuristic to skip when no parsed config is supplied", () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true }, group: {} } },
      channels: {
        telegram: { enabled: true },
        whatsapp: { enabled: true },
      },
      // No env-template and a single literal `agentId: "main"` binding. The
      // resolved-only fallback (no parsed config supplied) treats uniqueness
      // as the trip-prone signal and conservatively skips channel-wide
      // materialization; callers who can pass the parsed config can opt
      // into the more permissive behavior.
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "direct", id: "owner-1" } },
        },
      ],
    };
    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual(config.bindings);
    expect(result.changes).toContain(
      "Skipped telegram, whatsapp: identity-collision guard against main would trip EnvRefArrayMutationError during write.",
    );
  });

  it("uses the parsed config to allow sibling materialization when no env-template is present in the parsed file", () => {
    const config: OpenClawConfig = {
      agents: { entries: { main: { default: true }, group: {} } },
      channels: {
        telegram: { enabled: true },
        whatsapp: { enabled: true },
      },
      // Single literal `agentId: "main"` binding. The parsed config has
      // no env-template, so the env-preserve matcher would bypass the
      // identity path entirely; the migration can safely append.
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "direct", id: "owner-1" } },
        },
      ],
    };
    const result = materializeDefaultAgentRoles(config, { parsed: config });
    expect(result.config.bindings).toEqual([
      ...config.bindings!,
      { agentId: "main", match: { channel: "telegram", accountId: "*" } },
      { agentId: "main", match: { channel: "whatsapp", accountId: "*" } },
    ]);
  });

  it("skips channels whose existing bindings carry ${VAR} environment references", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { agentId: "ops" },
          systemAgent: { agentId: "ops" },
        },
        entries: { ops: { default: true }, research: {} },
      },
      channels: { telegram: { enabled: true } },
      bindings: [{ agentId: "${AGENT_ID}", match: { channel: "telegram", accountId: "work" } }],
      talk: { agentId: "ops", provider: "test" },
    };

    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual(config.bindings);
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(config);
  });

  it("materializes channels without env-bearing bindings while skipping siblings that have them", () => {
    const config: OpenClawConfig = {
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: {
        telegram: { enabled: true },
        slack: { enabled: true },
        whatsapp: { enabled: true },
      },
      bindings: [{ agentId: "${AGENT_ID}", match: { channel: "slack", accountId: "work" } }],
    };

    const result = materializeDefaultAgentRoles(config);
    expect(result.config.bindings).toEqual([
      ...config.bindings!,
      { agentId: "ops", match: { channel: "telegram", accountId: "*" } },
      { agentId: "ops", match: { channel: "whatsapp", accountId: "*" } },
    ]);
    expect(result.changes).toContain(
      'Bound telegram, whatsapp unbound account routing to agent "ops".',
    );
    expect(result.changes).toContain(
      "Skipped slack: existing binding uses an environment reference.",
    );
  });

  it("preserves malformed bindings and agent-default blocks for validation", () => {
    const base = {
      agents: { entries: { ops: { default: true }, research: {} } },
      channels: { telegram: { enabled: true } },
    } satisfies OpenClawConfig;
    const malformedBindings = { ...base, bindings: { bad: true } as never };
    expect(materializeDefaultAgentRoles(malformedBindings).config.bindings).toEqual({ bad: true });

    const malformedBindingEntry = {
      ...base,
      bindings: [null as never, { agentId: "ops" } as never],
    };
    expect(() => materializeDefaultAgentRoles(malformedBindingEntry)).not.toThrow();
    expect(materializeDefaultAgentRoles(malformedBindingEntry).config.bindings?.[1]).toEqual({
      agentId: "ops",
    });

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
