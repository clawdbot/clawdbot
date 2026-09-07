// System-agent legacy config migration tests.
import { describe, expect, it } from "vitest";
import { resolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type {
  AgentDefaultsConfig,
  AgentEntryConfig,
  OpenClawConfig,
} from "../../../config/types.js";
import { resolveHeartbeatAgents } from "../../../infra/heartbeat-config.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import {
  findLegacySystemAgentOwnerIssue,
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT,
} from "./legacy-config-migrations.runtime.system-agent.js";

const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT[0];

describe("system-agent config migration", () => {
  it("removes the retired config block", () => {
    const raw: Record<string, unknown> = {
      crestodian: { rescue: { enabled: true, pendingTtlMinutes: 10 } },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw).toEqual({});
    expect(changes).toEqual([
      "Removed retired crestodian config; system-agent rescue uses built-in policy.",
    ]);
  });

  it("does not mutate an independently retired systemAgent block", () => {
    const raw: Record<string, unknown> = {
      crestodian: { rescue: { enabled: true, ownerDmOnly: false } },
      systemAgent: { rescue: { enabled: false } },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw).toEqual({ systemAgent: { rescue: { enabled: false } } });
    expect(changes).toEqual([
      "Removed retired crestodian config; system-agent rescue uses built-in policy.",
    ]);
  });
});

describe("legacy ambient owner migration", () => {
  it.each(["entries", "list"])(
    "restores ambient ownership from a markerless %s roster",
    (shape) => {
      const raw: OpenClawConfig = {
        agents:
          shape === "entries"
            ? { entries: { ops: {}, main: {} } }
            : { list: [{ id: "ops" }, { id: "main" }] },
      };
      expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
      expect(resolveHeartbeatAgents(raw)).toEqual([]);
      expect(findLegacyConfigIssues(raw)).not.toContainEqual(
        expect.objectContaining({ path: "agents" }),
      );
      const result = migrateLegacyConfig(raw);
      expect(result.config).not.toBeNull();
      const migrated = result.config!;
      expect(migrated.agents?.defaults?.systemAgent?.agentId).toBe("main");
      expect(migrated.agents?.defaults?.heartbeat?.agentId).toBe("main");
      expect(resolveAmbientOwnerAgentId(migrated)).toBe("main");
      expect(resolveHeartbeatAgents(migrated).map(({ agentId }) => agentId)).toEqual(["main"]);
      expect(result.changes).toContain(
        "Set agents.defaults.systemAgent.agentId to main for legacy ambient operations.",
      );
      expect(applyLegacyDoctorMigrations(migrated)).toEqual({ next: null, changes: [] });
      expect(raw.agents?.defaults).toBeUndefined();
    },
  );

  describe.each(["entries", "list"])("already resolved %s rosters", (shape) => {
    it.each<{ label: string; entries: Record<string, AgentEntryConfig>; owner: string }>([
      { label: "sole main", entries: { main: {} }, owner: "main" },
      { label: "sole custom agent", entries: { ops: {} }, owner: "ops" },
      {
        label: "honored legacy default",
        entries: { main: {}, ops: { default: true } },
        owner: "ops",
      },
    ])("keeps $label quiet", ({ entries, owner }) => {
      const raw: OpenClawConfig = {
        agents:
          shape === "entries"
            ? { entries }
            : {
                list: Object.entries(entries).map(([id, config]) => Object.assign({ id }, config)),
              },
      };
      expect(resolveAmbientOwnerAgentId(raw)).toBe(owner);
      expect(findLegacySystemAgentOwnerIssue(raw)).toBeUndefined();
      const result = applyLegacyDoctorMigrations(raw);
      const migrated = (result.next ?? raw) as OpenClawConfig;
      expect(migrated.agents?.defaults?.systemAgent).toBeUndefined();
      expect(migrated.agents?.defaults?.heartbeat).toBeUndefined();
      expect(resolveAmbientOwnerAgentId(migrated)).toBe(owner);
      expect(applyLegacyDoctorMigrations(migrated)).toEqual({ next: null, changes: [] });
    });
  });

  it.each(["entries", "list"])(
    "seeds a marked default ignored by explicit %s ownership",
    (shape) => {
      const raw: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          ...(shape === "entries"
            ? { entries: { main: {}, ops: { default: true } } }
            : { list: [{ id: "main" }, { id: "ops", default: true }] }),
        },
      };
      expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
      const result = applyLegacyDoctorMigrations(raw);
      expect(result.next).toHaveProperty("agents.defaults.systemAgent.agentId", "ops");
    },
  );

  it.each<{
    label: string;
    defaults: AgentDefaultsConfig;
    entries: Record<string, AgentEntryConfig>;
    owners: string[];
  }>([
    {
      label: "explicit owner",
      defaults: { heartbeat: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
      owners: ["ops"],
    },
    {
      label: "shared defaults",
      defaults: { heartbeat: { every: "1h" } },
      entries: { main: {}, ops: {} },
      owners: ["main", "ops"],
    },
    {
      label: "per-agent enrollment",
      defaults: {},
      entries: { main: {}, ops: { heartbeat: { every: "1h" } } },
      owners: ["ops"],
    },
  ])("preserves heartbeat $label", ({ defaults, entries, owners }) => {
    const raw: OpenClawConfig = { agents: { defaults, entries } };
    expect(resolveHeartbeatAgents(raw).map(({ agentId }) => agentId)).toEqual(owners);
    const result = applyLegacyDoctorMigrations(raw);
    const migrated = result.next as OpenClawConfig;
    expect(migrated.agents?.defaults?.systemAgent?.agentId).toBe("main");
    expect(migrated.agents?.defaults?.heartbeat).toEqual(defaults.heartbeat);
    expect(resolveHeartbeatAgents(migrated).map(({ agentId }) => agentId)).toEqual(owners);
  });

  it.each([
    {},
    { agents: { entries: { ops: {}, worker: {} } } },
    { agents: { entries: { main: { default: true }, ops: { default: true } } } },
    { agents: { entries: { main: {} }, defaults: { systemAgent: null } } },
    { agents: { entries: { main: {}, ops: {} }, defaults: { systemAgent: { agentId: "ops" } } } },
  ])("leaves absent defaults and explicit owners alone: %j", (raw) => {
    expect(applyLegacyDoctorMigrations(raw)).toEqual({ next: null, changes: [] });
  });
});
