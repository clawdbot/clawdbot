// Doctor heartbeat session-target tests cover heartbeat target checks and repair output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";

describe("describeHeartbeatSessionTargetIssues", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heartbeat-doctor-"));
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function cfgWithSession(session: string, target: string | null = "slack"): OpenClawConfig {
    const heartbeat = target === null ? { session } : { session, target };
    return {
      session: {
        mainKey: "work",
        store: path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: {
        list: [
          {
            id: "ops",
            heartbeat,
          },
        ],
      },
    } as OpenClawConfig;
  }

  function cfgWithDefaultHeartbeat(
    session: string,
    target: string | null = "slack",
  ): OpenClawConfig {
    const heartbeat = target === null ? { session } : { session, target };
    return {
      session: {
        mainKey: "work",
        store: path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
      agents: {
        defaults: {
          heartbeat,
        },
        list: [
          {
            id: "ops",
          },
        ],
      },
    } as OpenClawConfig;
  }

  function writeStore(cfg: OpenClawConfig, entries: Record<string, unknown>) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(entries, null, 2));
  }

  it("uses runtime session canonicalization before warning", () => {
    const cfg = cfgWithSession("agent:ops:main");
    writeStore(cfg, {
      "agent:ops:work": {
        sessionId: "work-session",
        updatedAt: Date.now(),
      },
    });

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("recognizes a SQLite-resident heartbeat target", async () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: "agent:ops:slack:channel:c123", storePath },
      { sessionId: "sqlite-heartbeat-target", updatedAt: Date.now() },
    );

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("warns when the resolved heartbeat session is missing", () => {
    const cfg = cfgWithSession("slack:channel:c123");
    writeStore(cfg, {});

    const warnings = describeHeartbeatSessionTargetIssues(cfg);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "ops",
    }).path;
    expect(warnings[0]).toContain(`no entry in ${databasePath}`);
    expect(warnings[0]).not.toContain(`no entry in ${storePath}`);
    expect(warnings[0]).toContain('reason="no-target"');
    expect(warnings[0]).toContain("Heartbeats will run");
  });

  it("does not warn when an explicit heartbeat recipient does not need session history", () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const agent = cfg.agents?.list?.[0];
    if (!agent?.heartbeat) {
      throw new Error("expected test config to include heartbeat config");
    }
    agent.heartbeat.target = "telegram";
    agent.heartbeat.to = "-100123";
    writeStore(cfg, {});

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it("does not warn when the heartbeat cadence is disabled", () => {
    const cfg = cfgWithSession("slack:channel:c123");
    const agent = cfg.agents?.list?.[0];
    if (!agent?.heartbeat) {
      throw new Error("expected test config to include heartbeat config");
    }
    agent.heartbeat.every = "0m";
    writeStore(cfg, {});

    expect(describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
  });

  it.each([
    {
      name: "the sole default-only agent",
      configuredAgentIds: ["ops"],
      heartbeatAgentId: undefined,
      expectedAgentIds: ["ops"],
    },
    {
      name: "every agent sharing heartbeat defaults",
      configuredAgentIds: ["main", "ops"],
      heartbeatAgentId: undefined,
      expectedAgentIds: ["main", "ops"],
    },
    {
      name: "only the explicit default heartbeat owner",
      configuredAgentIds: ["main", "ops"],
      heartbeatAgentId: "ops",
      expectedAgentIds: ["ops"],
    },
  ])(
    "warns for missing sessions owned by $name",
    ({ configuredAgentIds, heartbeatAgentId, expectedAgentIds }) => {
      const cfg = cfgWithDefaultHeartbeat("slack:channel:c123");
      if (!cfg.agents?.defaults?.heartbeat) {
        throw new Error("expected test config to include default heartbeat config");
      }
      cfg.agents.list = configuredAgentIds.map((id) => ({ id }));
      cfg.agents.defaults.heartbeat.agentId = heartbeatAgentId;
      writeStore(cfg, {});

      const warnings = describeHeartbeatSessionTargetIssues(cfg);

      expect(warnings).toHaveLength(expectedAgentIds.length);
      for (const [index, agentId] of expectedAgentIds.entries()) {
        expect(warnings[index]).toContain(
          `Agent ${agentId} heartbeat.session pins slack:channel:c123`,
        );
        expect(warnings[index]).toContain(`resolved to agent:${agentId}:slack:channel:c123`);
      }
    },
  );

  it("warns when an explicit heartbeat inherits a default session", () => {
    const cfg = cfgWithDefaultHeartbeat("slack:channel:c123");
    const agent = cfg.agents?.list?.[0];
    if (!agent) {
      throw new Error("expected test config to include an agent");
    }
    agent.heartbeat = {};
    writeStore(cfg, {});

    const warnings = describeHeartbeatSessionTargetIssues(cfg);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
  });

  it("warns when the default owner target has no configured owner route", () => {
    const cfg = cfgWithSession("slack:channel:c123", null);
    writeStore(cfg, {});

    const warning = describeHeartbeatSessionTargetIssues(cfg)[0];
    expect(warning).toContain('reason="no-route"');
    expect(warning).toContain("set commands.ownerAllowFrom or a channel allowFrom");
  });
});
