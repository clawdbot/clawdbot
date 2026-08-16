import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { buildHealthSessionSummary } from "./collector.js";

describe("health session store paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("reports the SQLite database that supplied the session count", async () => {
    const stateDir = tempDirs.make("openclaw-health-session-store-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "main";
    const storePath = resolveSessionStorePathCore(undefined, { agentId, env });
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });

    await upsertSessionEntryCore(
      { agentId, env, sessionKey: `agent:${agentId}:main`, storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
    closeOpenClawAgentDatabasesForTest();

    const summary = await buildHealthSessionSummary(storePath, agentId);

    expect(summary.count).toBe(1);
    expect(summary.path).toBe(databasePath);
    expect(fs.existsSync(summary.path)).toBe(true);
  });

  it("preserves configured store templates and reports empty agent targets", async () => {
    const stateDir = tempDirs.make("openclaw-health-session-template-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "stores", "{agentId}", "sessions.json");
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
      path.join(stateDir, "stores", populatedAgentId, "sessions.json"),
    );
    await upsertSessionEntryCore(
      {
        agentId: populatedAgentId,
        env,
        sessionKey: `agent:${populatedAgentId}:main`,
        storePath: populatedStorePath,
      },
      { sessionId: "session-1", updatedAt: 10 },
    );
    closeOpenClawAgentDatabasesForTest();

    const populated = await buildHealthSessionSummary(populatedStorePath, populatedAgentId);
    const emptyAgentId = "third";
    const emptyStorePath = resolveSessionStorePathCore(storeTemplate, {
      agentId: emptyAgentId,
      env,
    });
    const empty = await buildHealthSessionSummary(emptyStorePath, emptyAgentId);

    expect(populated).toMatchObject({ count: 1, path: populatedDatabasePath });
    expect(fs.existsSync(populated.path)).toBe(true);
    expect(empty).toMatchObject({
      count: 0,
      path: resolveSqliteTargetFromSessionStorePath(emptyStorePath, {
        agentId: emptyAgentId,
        env,
      }).path,
    });
  });
});
