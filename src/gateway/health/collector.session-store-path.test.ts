import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as configRuntime from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  buildHealthAgentSummaries,
  collectGatewayHealthSnapshot,
  resolveHealthAgentOrder,
} from "./collector.js";

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

async function summarizeStore(storePath: string, agentId: string) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { [agentId]: {} } },
    session: { store: storePath },
  };
  const agents = await buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg));
  return expectDefined(agents[0], "health agent summary").sessions;
}

describe("health session store paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("reports the SQLite database that supplied the session count", async () => {
    const stateDir = tempDirs.make("openclaw-health-session-store-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "main";
    const storePath = resolveSessionStorePathCore(undefined, { agentId, env });
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });

    await sessionAccessor.upsertSessionEntryCore(
      { agentId, env, sessionKey: `agent:${agentId}:main`, storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
    closeOpenClawAgentDatabasesForTest();

    const summary = await summarizeStore(storePath, agentId);

    expect(summary.count).toBe(1);
    expect(summary.path).toBe(databasePath);
    expect(fs.existsSync(summary.path)).toBe(true);
  });

  it.each(["agent", "shared"] as const)(
    "counts and orders bounded %s session projections without cloning full entries",
    async (layout) => {
      const stateDir = tempDirs.make("openclaw-health-session-projection-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentIds = layout === "shared" ? ["main", "other"] : ["main"];
      const storePath =
        layout === "shared"
          ? path.join(stateDir, "shared.sqlite")
          : resolveSessionStorePathCore(undefined, { agentId: "main", env });
      const now = vi.spyOn(Date, "now");
      for (const agentId of agentIds) {
        for (const timestamp of [30, 70, 10, 60, 40, 20, 50]) {
          const updatedAt = timestamp + (agentId === "other" ? 100 : 0);
          now.mockReturnValue(updatedAt);
          await sessionAccessor.upsertSessionEntryCore(
            { agentId, env, sessionKey: `agent:${agentId}:session-${timestamp}`, storePath },
            {
              sessionId: `session-${agentId}-${timestamp}`,
              updatedAt,
              skillsSnapshot: { prompt: "large runtime prompt", skills: [{ name: "demo" }] },
            },
          );
        }
      }
      const inspectedAt = layout === "shared" ? 200 : 100;
      now.mockReturnValue(inspectedAt);
      // Cold-open canonical validation is separate from the warm health projection.
      sessionAccessor.loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: "agent:main:session-70",
        storePath,
      });
      const clone = vi.spyOn(globalThis, "structuredClone");
      const parse = vi.spyOn(JSON, "parse");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
        },
        session: { store: storePath },
      };

      const agents = await buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg));

      expect(clone).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: expect.stringMatching(/^session-/) }),
      );
      expect(
        parse.mock.calls.filter(
          ([value]) => typeof value === "string" && /session-(main|other)-(10|20)"/u.test(value),
        ),
      ).toHaveLength(0);
      expect(agents.map((agent) => agent.agentId)).toEqual(agentIds);
      for (const agent of agents) {
        expect(agent.sessions).toMatchObject({
          count: 7,
          recent: [70, 60, 50, 40, 30].map((timestamp) => {
            const updatedAt = timestamp + (agent.agentId === "other" ? 100 : 0);
            return {
              key: `agent:${agent.agentId}:session-${timestamp}`,
              updatedAt,
              age: inspectedAt - updatedAt,
            };
          }),
        });
      }
    },
  );

  it.each(["template", "shared"] as const)(
    "scopes %s stores and recovers from transient reads",
    async (layout) => {
      const stateDir = tempDirs.make("openclaw-health-session-template-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(
        stateDir,
        "stores",
        layout === "shared" ? "shared.sqlite" : "{agentId}/sessions.json",
      );
      const populatedAgentId = "helper";
      const populatedStorePath = resolveSessionStorePathCore(storeTemplate, {
        agentId: populatedAgentId,
        env,
      });
      const populatedDatabasePath = resolveSqliteTargetFromSessionStorePath(populatedStorePath, {
        agentId: populatedAgentId,
        env,
      }).path;

      expect(populatedStorePath).toBe(
        layout === "shared"
          ? path.join(stateDir, "stores", "shared.sqlite")
          : path.join(stateDir, "stores", populatedAgentId, "sessions.json"),
      );
      await sessionAccessor.upsertSessionEntryCore(
        {
          agentId: populatedAgentId,
          env,
          sessionKey: `agent:${populatedAgentId}:main`,
          storePath: populatedStorePath,
        },
        { sessionId: "session-1", updatedAt: 10 },
      );
      closeOpenClawAgentDatabasesForTest();

      const populated = await summarizeStore(populatedStorePath, populatedAgentId);
      const emptyAgentId = "third";
      const emptyStorePath = resolveSessionStorePathCore(storeTemplate, {
        agentId: emptyAgentId,
        env,
      });
      const empty = await summarizeStore(emptyStorePath, emptyAgentId);

      expect(populated).toMatchObject({ count: 1, path: populatedDatabasePath });
      expect(fs.existsSync(populated.path)).toBe(true);
      expect(empty).toMatchObject({
        count: 0,
        path: resolveSqliteTargetFromSessionStorePath(emptyStorePath, {
          agentId: emptyAgentId,
          env,
        }).path,
      });

      vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue({
        agents: { ownership: "explicit", entries: { helper: {}, third: {} } },
        session: { store: storeTemplate },
      });
      const reads = vi.spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly");
      const collect = () => collectGatewayHealthSnapshot({ audience: "admin", probe: false });
      const summary = await collect();
      expect(summary.agents.map((agent) => [agent.agentId, agent.sessions.count])).toEqual([
        [populatedAgentId, 1],
        [emptyAgentId, 0],
      ]);
      expect(summary.sessions).toEqual(summary.agents[0]?.sessions);
      expect(reads).toHaveBeenCalledTimes(layout === "shared" ? 1 : 2);

      reads.mockClear().mockImplementationOnce(() => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      });
      expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([0, 0]);
      expect(reads).toHaveBeenCalledTimes(layout === "shared" ? 1 : 2);
      expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([1, 0]);

      const fatal = new Error("invalid session state");
      reads.mockImplementationOnce(() => {
        throw fatal;
      });
      await expect(collect()).rejects.toBe(fatal);
    },
  );
});
