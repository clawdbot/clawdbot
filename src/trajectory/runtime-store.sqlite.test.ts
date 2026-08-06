// SQLite trajectory runtime tests cover session-scoped event row storage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  loadSqliteTrajectoryRuntimeEventRowsSync,
  loadSqliteTrajectoryRuntimeEvents,
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
    vi.useRealTimers();
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
  });

  it("loads a bounded trailing window in storage order", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "event-1" }),
      createTrajectoryEvent({ type: "event-2" }),
      createTrajectoryEvent({ type: "event-3" }),
    ]);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      tailEvents: 2,
    });

    expect(rows.map((row) => row.event.type)).toEqual(["event-2", "event-3"]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("applies maxEvents to a trailing window", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "event-1" }),
      createTrajectoryEvent({ type: "event-2" }),
      createTrajectoryEvent({ type: "event-3" }),
    ]);

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      tailEvents: 3,
      maxEvents: 1,
    });

    expect(rows.map((row) => row.event.type)).toEqual(["event-3"]);
  });

  it("drops old runs while retaining recent runs", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current", ts: new Date(now).toISOString() }),
    ]);
    await addSession("history");
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "history", storePath }, [
      createTrajectoryEvent({
        runId: "old-run",
        sessionId: "history",
        type: "old",
        ts: new Date(now - 15 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      createTrajectoryEvent({
        runId: "recent-run",
        sessionId: "history",
        type: "recent",
        ts: new Date(now - 13 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    ]);

    vi.advanceTimersByTime(60 * 60 * 1_000);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "sweep-trigger", ts: new Date(Date.now()).toISOString() }),
    ]);

    await expect(runtimeEventTypes("history")).resolves.toEqual(["recent"]);
  });

  it("evicts oldest runs to the global byte budget without touching the current session", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ payloadSize: 200, type: "current-initial" }),
    ]);
    for (const [index, sessionId] of ["oldest", "middle", "newest"].entries()) {
      await addSession(sessionId);
      appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, [
        createTrajectoryEvent({
          payloadSize: 200,
          runId: `${sessionId}-run`,
          sessionId,
          type: sessionId,
          ts: new Date(now - (3 - index) * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      ]);
    }
    const bytesBefore = runtimeBytesBySession();
    const trigger = createTrajectoryEvent({
      payloadSize: 200,
      type: "current-newest",
      ts: new Date(now + 60 * 60 * 1_000).toISOString(),
    });
    const triggerBytes = Buffer.byteLength(JSON.stringify(trigger), "utf8") + 1;
    const maxGlobalRuntimeBytes =
      [...bytesBefore.values()].reduce((total, bytes) => total + bytes, 0) +
      triggerBytes -
      (bytesBefore.get("oldest") ?? 0) -
      (bytesBefore.get("middle") ?? 0);

    vi.advanceTimersByTime(60 * 60 * 1_000);
    appendSqliteTrajectoryRuntimeEvents(
      { maxGlobalRuntimeBytes, sessionId: "session-1", storePath },
      [trigger],
    );

    await expect(runtimeEventTypes("oldest")).resolves.toEqual([]);
    await expect(runtimeEventTypes("middle")).resolves.toEqual([]);
    await expect(runtimeEventTypes("newest")).resolves.toEqual(["newest"]);
    await expect(runtimeEventTypes("session-1")).resolves.toEqual([
      "current-initial",
      "current-newest",
    ]);
  });

  it("rate-limits the global sweep instead of running it on every insert", async () => {
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "current" }),
    ]);
    await addSession("old-session");
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "old-session", storePath }, [
      createTrajectoryEvent({
        sessionId: "old-session",
        type: "old",
        ts: new Date(now - 15 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
    ]);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "same-window" }),
    ]);
    await expect(runtimeEventTypes("old-session")).resolves.toEqual(["old"]);

    vi.advanceTimersByTime(60 * 60 * 1_000);
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "next-window", ts: new Date(Date.now()).toISOString() }),
    ]);
    await expect(runtimeEventTypes("old-session")).resolves.toEqual([]);
  });

  it("cascades trajectory rows when the session row is deleted", async () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ type: "model.started" }),
    ]);

    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    database.db.prepare("DELETE FROM session_windows WHERE session_id = ?").run("session-1");

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
  });

  function sqlitePath(): string {
    return path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  }

  async function addSession(sessionId: string): Promise<void> {
    await replaceSessionEntry(
      { sessionKey: `agent:main:${sessionId}`, storePath },
      { sessionId, updatedAt: Date.now() },
    );
  }

  async function runtimeEventTypes(sessionId: string): Promise<string[]> {
    const events = await loadSqliteTrajectoryRuntimeEvents({ sessionId, storePath });
    return events.map((event) => event.type);
  }

  function runtimeBytesBySession(): Map<string, number> {
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("trajectory_runtime_events").select(["session_id", "event_json"]),
    ).rows;
    const bytesBySession = new Map<string, number>();
    for (const row of rows) {
      bytesBySession.set(
        row.session_id,
        (bytesBySession.get(row.session_id) ?? 0) + Buffer.byteLength(row.event_json, "utf8") + 1,
      );
    }
    return bytesBySession;
  }
});

function createTrajectoryEvent(options: {
  payloadSize?: number;
  runId?: string;
  seq?: number;
  sessionId?: string;
  ts?: string;
  type: string;
}): TrajectoryEvent {
  const sessionId = options.sessionId ?? "session-1";
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: options.type,
    ts: options.ts ?? "2026-07-03T00:00:00.000Z",
    seq: options.seq ?? 1,
    sourceSeq: options.seq ?? 1,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    runId: options.runId ?? "run-1",
    data: { payload: "x".repeat(options.payloadSize ?? 120) },
  };
}
