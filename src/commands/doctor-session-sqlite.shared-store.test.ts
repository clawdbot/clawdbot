import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function createStore(layout: "shared" | "custom") {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-doctor-canonical-store-"));
  const stateDir = path.join(root, "state");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(
    root,
    "custom",
    layout === "shared" ? "shared.sqlite" : "sessions.json",
  );
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { qa: {} } },
    session: { store: storePath },
  };
  const scope = {
    agentId: "qa",
    defaultAgentId: "main",
    env,
    sessionKey: "agent:qa:doctor",
    storePath,
  };
  await upsertSessionEntryCore(scope, { sessionId: "doctor-session", updatedAt: 1 });
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  const sqlitePath = resolveOpenClawAgentSqlitePath(options);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { cfg, env, options, scope, sqlitePath, stateDir, storePath };
}

describe("Doctor canonical session SQLite targets", () => {
  it.each(["dry-run", "import", "validate"] as const)(
    "%s never treats an exact SQLite database as a legacy file",
    async (mode) => {
      const store = await createStore("shared");
      const original = fs.readFileSync(store.sqlitePath);
      const report = await runDoctorSessionSqlite({
        cfg: store.cfg,
        env: store.env,
        allAgents: true,
        mode,
      });

      expect(report.targets).toEqual([]);
      expect(report.migrationRun).toBeUndefined();
      expect(fs.readFileSync(store.sqlitePath)).toEqual(original);
      expect(fs.existsSync(path.join(store.stateDir, "session-sqlite-migration-runs"))).toBe(false);
      expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
    },
  );

  it.each(["shared", "custom"] as const)(
    "inspects the %s SQLite database without a legacy session file",
    async (layout) => {
      const store = await createStore(layout);
      const report = await runDoctorSessionSqlite({
        cfg: store.cfg,
        env: store.env,
        allAgents: true,
        mode: "inspect",
      });

      expect(report.totals).toMatchObject({
        targets: 1,
        legacyEntries: 0,
        sqliteEntries: 1,
        issues: 0,
      });
      expect(report.targets[0]?.sqlitePath).toBe(store.sqlitePath);
      expect(report.targets[0]?.dbStats?.integrityCheck).toBe("ok");
      expect(loadExactSessionEntry(store.scope)?.entry.sessionId).toBe("doctor-session");
      expect(openOpenClawAgentDatabase(store.options).agentId).toBe(
        layout === "shared" ? "main" : "qa",
      );
    },
  );

  it("includes the default SQLite target after its legacy file has been retired", async () => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-doctor-default-store-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    await upsertSessionEntryCore(
      { agentId: "main", env, sessionKey: "agent:main:doctor" },
      { sessionId: "default-session", updatedAt: 1 },
    );
    const report = await runDoctorSessionSqlite({ cfg, env, mode: "inspect" });
    expect(report.totals).toMatchObject({
      targets: 1,
      legacyEntries: 0,
      sqliteEntries: 1,
      issues: 0,
    });
  });
});
