import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { sweepTombstonedCronRunRemnants } from "./cleanup-tombstones.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const DAY_MS = 24 * 60 * 60 * 1000;
const CRON_RUN_KEY = "agent:main:cron:job-1:run:run-1";
const LIVE_KEY = "agent:main:direct:human";

describe("sweepTombstonedCronRunRemnants", () => {
  let tempDir: string;
  let storePath: string;
  let sqlitePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-tombstone-sweep-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    closeOpenClawAgentDatabasesForTest();
  });

  /**
   * Seeds the observed production debris shape directly: a cron-run
   * session_nodes row whose entry_json lost its sessionId (the tombstone
   * deleteSqliteSessionEntryRows writes when transcript windows survive an
   * entry removal), with the windows and transcript events still present.
   */
  async function seedTombstonedCronRun(params: { ageDays: number }): Promise<string> {
    const sessionId = `cron-session-${params.ageDays}`;
    await replaceSessionEntry(
      { sessionKey: CRON_RUN_KEY, storePath },
      { sessionId, updatedAt: Date.now() },
    );
    await replaceSqliteTranscriptEvents({ sessionKey: CRON_RUN_KEY, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "cron run transcript" },
    ]);
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({
          entry_json: JSON.stringify({ delivery: { kind: "none" } }),
          updated_at: Date.now() - params.ageDays * DAY_MS,
        })
        .where("session_key", "=", CRON_RUN_KEY),
    );
    return sessionId;
  }

  function openDatabase() {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected sqlite database path");
    }
    sqlitePath = databasePath;
    return openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  }

  function countRows(table: "session_nodes" | "session_windows"): number {
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db.selectFrom(table).select("session_key"),
    ).rows.filter((row) => row.session_key === CRON_RUN_KEY).length;
  }

  it("deletes aged cron-run tombstones with their windows and transcript state", async () => {
    await seedTombstonedCronRun({ ageDays: 20 });
    // Live non-cron session must be untouched.
    await replaceSessionEntry(
      { sessionKey: LIVE_KEY, storePath },
      { sessionId: "live-session", updatedAt: Date.now() },
    );
    expect(countRows("session_nodes")).toBe(1);

    const dry = await sweepTombstonedCronRunRemnants({
      agentId: "main",
      sqlitePath,
      olderThanMs: 15 * DAY_MS,
      dryRun: true,
    });
    expect(dry).toMatchObject({ candidates: 1, removedNodes: 0 });
    expect(countRows("session_nodes")).toBe(1);

    const applied = await sweepTombstonedCronRunRemnants({
      agentId: "main",
      sqlitePath,
      olderThanMs: 15 * DAY_MS,
      dryRun: false,
    });
    expect(applied).toMatchObject({ candidates: 1, removedNodes: 1 });
    expect(applied.sweptTranscriptStates).toBeGreaterThanOrEqual(1);
    expect(countRows("session_nodes")).toBe(0);
    expect(countRows("session_windows")).toBe(0);

    // Idempotent: nothing left to sweep.
    const rerun = await sweepTombstonedCronRunRemnants({
      agentId: "main",
      sqlitePath,
      olderThanMs: 15 * DAY_MS,
      dryRun: false,
    });
    expect(rerun).toMatchObject({ candidates: 0, removedNodes: 0 });
  });

  it("keeps tombstones younger than the age gate", async () => {
    await seedTombstonedCronRun({ ageDays: 5 });
    const applied = await sweepTombstonedCronRunRemnants({
      agentId: "main",
      sqlitePath,
      olderThanMs: 15 * DAY_MS,
      dryRun: false,
    });
    expect(applied).toMatchObject({ candidates: 0, removedNodes: 0 });
    expect(countRows("session_nodes")).toBe(1);
  });

  it("never touches live sessions, cron or otherwise", async () => {
    await replaceSessionEntry(
      { sessionKey: "agent:main:cron:job-2:run:run-2", storePath },
      { sessionId: "live-cron-run", updatedAt: Date.now() - 40 * DAY_MS },
    );
    const database = openDatabase();
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ updated_at: Date.now() - 40 * DAY_MS })
        .where("session_key", "=", "agent:main:cron:job-2:run:run-2"),
    );
    const applied = await sweepTombstonedCronRunRemnants({
      agentId: "main",
      sqlitePath,
      olderThanMs: 15 * DAY_MS,
      dryRun: false,
    });
    // Old but LIVE (entry_json still has a sessionId): not a tombstone.
    expect(applied).toMatchObject({ candidates: 0, removedNodes: 0 });
  });
});
