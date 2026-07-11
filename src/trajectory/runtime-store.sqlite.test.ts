// SQLite trajectory runtime tests cover session-scoped event row storage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
  readSqliteTrajectoryRuntimeStatsSync,
} from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

type TrajectoryRuntimeTestDatabase = Pick<OpenClawAgentKyselyDatabase, "trajectory_runtime_events">;

describe("SQLite trajectory runtime store", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-sqlite-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:main", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends events in database order without trusting recorder-local seq", async () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ seq: 1, type: "model.started" }),
      createTrajectoryEvent({ seq: 1, type: "model.completed" }),
    ]);

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([
      expect.objectContaining({ seq: 1, type: "model.started" }),
      expect.objectContaining({ seq: 1, type: "model.completed" }),
    ]);

    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("trajectory_runtime_events")
        .select(["seq", "run_id"])
        .where("session_id", "=", "session-1")
        .orderBy("seq", "asc"),
    ).rows;
    expect(rows).toEqual([
      { run_id: "run-1", seq: 0 },
      { run_id: "run-1", seq: 1 },
    ]);
  });

  it("trims oldest rows beyond the configured byte window", async () => {
    appendSqliteTrajectoryRuntimeEvents(
      { maxRuntimeBytes: 900, sessionId: "session-1", storePath },
      [
        createTrajectoryEvent({ type: "event-1" }),
        createTrajectoryEvent({ type: "event-2" }),
        createTrajectoryEvent({ type: "event-3" }),
        createTrajectoryEvent({ type: "event-4" }),
      ],
    );

    const events = await loadSqliteTrajectoryRuntimeEvents({
      sessionId: "session-1",
      storePath,
    });

    expect(events.map((event) => event.type)).toEqual(["event-3", "event-4"]);
    expect(readSqliteTrajectoryRuntimeStatsSync({ sessionId: "session-1", storePath })).toEqual({
      eventCount: 2,
      maxSeq: 3,
      sizeBytes: expect.any(Number),
    });
  });

  it("cascades trajectory rows when the session row is deleted", async () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "model.started" }),
    ]);

    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    database.db.prepare("DELETE FROM sessions WHERE session_id = ?").run("session-1");

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
  });

  function sqlitePath(): string {
    return path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  }
});

function createTrajectoryEvent(options: { seq?: number; type: string }): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "session-1",
    source: "runtime",
    type: options.type,
    ts: "2026-07-03T00:00:00.000Z",
    seq: options.seq ?? 1,
    sourceSeq: options.seq ?? 1,
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    runId: "run-1",
    data: { payload: "x".repeat(120) },
  };
}
