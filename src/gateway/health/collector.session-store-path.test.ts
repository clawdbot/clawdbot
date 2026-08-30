import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as configRuntime from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { collectGatewayHealthSnapshot } from "./collector.js";

async function summarizeStore(storePath: string, agentId: string) {
  vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue({
    agents: { ownership: "explicit", entries: { [agentId]: {} } },
    session: { store: storePath },
  });
  return (await collectGatewayHealthSnapshot({ audience: "admin", probe: false })).sessions;
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

  it("counts and orders lightweight session projections without cloning full entries", async () => {
    const stateDir = tempDirs.make("openclaw-health-session-projection-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "main";
    const storePath = resolveSessionStorePathCore(undefined, { agentId, env });
    const now = vi.spyOn(Date, "now");
    for (const updatedAt of [30, 70, 10, 60, 40, 20, 50]) {
      now.mockReturnValue(updatedAt);
      await sessionAccessor.upsertSessionEntryCore(
        { agentId, env, sessionKey: `agent:${agentId}:session-${updatedAt}`, storePath },
        {
          sessionId: `session-${updatedAt}`,
          updatedAt,
          skillsSnapshot: { prompt: "large runtime prompt", skills: [{ name: "demo" }] },
        },
      );
    }
    now.mockReturnValue(100);
    const clone = vi.spyOn(globalThis, "structuredClone");

    const summary = await summarizeStore(storePath, agentId);

    expect(clone).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: expect.stringMatching(/^session-/) }),
    );
    expect(summary).toMatchObject({
      count: 7,
      recent: [
        { key: "agent:main:session-70", updatedAt: 70, age: 30 },
        { key: "agent:main:session-60", updatedAt: 60, age: 40 },
        { key: "agent:main:session-50", updatedAt: 50, age: 50 },
        { key: "agent:main:session-40", updatedAt: 40, age: 60 },
        { key: "agent:main:session-30", updatedAt: 30, age: 70 },
      ],
    });
  });

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
      const reads = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");
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
