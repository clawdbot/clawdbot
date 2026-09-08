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

  it.each(["2026", "0", "1969-12-31T23:59:59.000Z"])(
    "stores Date.parse-compatible trajectory timestamp %s",
    (timestamp) => {
      appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
        createTrajectoryEvent({ ts: timestamp, type: "timestamp-contract" }),
      ]);

      const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
      const db = getNodeSqliteKysely<TrajectoryRuntimeTestDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("trajectory_runtime_events")
          .select(["created_at"])
          .where("session_id", "=", "session-1"),
      ).rows;
      expect(rows).toEqual([{ created_at: Date.parse(timestamp) }]);
    },
  );

  it("rejects a foreign owner for a non-shared agent store on append and read", async () => {
    const foreign = { agentId: "ops", sessionId: "session-1", storePath };
    expect(() =>
      appendSqliteTrajectoryRuntimeEvents(foreign, [createTrajectoryEvent({ type: "foreign" })]),
    ).toThrow(/store path belongs to agent main; requested agent ops/);
    expect(() => loadSqliteTrajectoryRuntimeEventRowsSync(foreign)).toThrow(
      /store path belongs to agent main; requested agent ops/,
    );
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1", storePath }),
    ).resolves.toEqual([]);
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

  it("stops reading old event bodies once the retained byte window is full", async () => {
    const history = Array.from({ length: 64 }, (_, index) =>
      createTrajectoryEvent({ type: `old-${index}`, payloadSize: 64 * 1024 }),
    );
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, history);
    const newest = createTrajectoryEvent({ type: "newest" });
    const retained = [...history.slice(-2), newest];
    const maxRuntimeBytes = retained.reduce(
      (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
      0,
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath() });
    const prepare = database.db.prepare.bind(database.db);
    let materializedEvents = 0;
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        for (const row of iterate(...args)) {
          if (typeof row.event_json === "string") {
            materializedEvents += 1;
          }
          yield row;
        }
        return undefined;
      });
      return statement;
    });
    try {
      appendSqliteTrajectoryRuntimeEvents({ maxRuntimeBytes, sessionId: "session-1", storePath }, [
        newest,
      ]);
      expect(materializedEvents).toBeLessThanOrEqual(retained.length + 1);
    } finally {
      prepareSpy.mockRestore();
    }
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual(retained);
  });

  it.each([0, -1])("keeps the exact UTF-8 byte window with a %i-byte adjustment", async (delta) => {
    const events = ["old", "middle", "newest"].map((type) => {
      const event = createTrajectoryEvent({ type });
      event.data = { payload: "日本語🦞".repeat(20) };
      return event;
    });
    const maxRuntimeBytes = events
      .slice(-2)
      .reduce(
        (bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
        delta,
      );
    appendSqliteTrajectoryRuntimeEvents(
      { maxRuntimeBytes, sessionId: "session-1", storePath },
      events,
    );
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual(events.slice(delta === 0 ? -2 : -1));
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

  it("reads a missing trajectory store without creating an agent database", () => {
    const missingStorePath = path.join(tempDir, "agents", "missing", "sessions", "sessions.json");
    const missingDatabasePath = path.join(
      tempDir,
      "agents",
      "missing",
      "agent",
      "openclaw-agent.sqlite",
    );

    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        agentId: "missing",
        sessionId: "missing-session",
        storePath: missingStorePath,
      }),
    ).toEqual([]);
    expect(fs.existsSync(missingDatabasePath)).toBe(false);
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

describe("SQLite trajectory runtime reader byte and count budgets", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-sqlite-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:session-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects oversized SQLite runtime store rows before parsing them", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ seq: 1, type: "budget-row-1", payloadSize: 256 }),
      createTrajectoryEvent({ seq: 2, type: "budget-row-2", payloadSize: 256 }),
    ]);

    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: 64,
      }),
    ).toThrow(/runtime store is too large to export/u);
  });

  it("rejects SQLite runtime store event count before parsing rows", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ seq: 1, type: "count-row-1" }),
      createTrajectoryEvent({ seq: 2, type: "count-row-2" }),
    ]);

    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 1,
      }),
    ).toThrow(/runtime store has too many events to export/u);
  });

  it("accepts a SQLite runtime event-count budget equal to the row count and rejects one over", () => {
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [
      createTrajectoryEvent({ seq: 1, type: "boundary-row-1" }),
      createTrajectoryEvent({ seq: 2, type: "boundary-row-2" }),
    ]);

    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 2,
      }).length,
    ).toBe(2);
    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventCount: 1,
      }),
    ).toThrow(/runtime store has too many events to export/u);
  });

  it("counts JSONL row separators in the runtime byte budget", () => {
    const events: TrajectoryEvent[] = [];
    const ROWS = 50;
    for (let i = 0; i < ROWS; i += 1) {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "sqlite-runtime",
        ts: "2026-04-01T05:46:41.000Z",
        seq: i + 1,
        sourceSeq: i + 1,
        sessionId: "session-1",
        data: { payload: "s" },
      });
    }
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [...events]);
    const rawSum = events.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
      0,
    );
    const jsonlSize = rawSum + ROWS - 1;
    expect(() =>
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: rawSum,
      }),
    ).toThrow(/runtime store is too large to export/u);
    expect(
      loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: jsonlSize,
      }).length,
    ).toBe(ROWS);
  });
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

import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";

/**
 * Insert a competing oversized row via a second writable connection. Called
 * between the production reader's budget aggregate and payload SELECT by
 * intercepting the reader connection's prepare() — the same test-local native
 * statement instrumentation pattern this suite uses for materialization checks.
 */
function createCompetingRowInjector(
  dbPath: string,
  sessionId: string,
): { inject: () => void; close: () => void } {
  const writerDb = openNodeSqliteDatabase(dbPath);
  const competingEvent = createTrajectoryEvent({
    seq: 2,
    type: "competing-row",
    payloadSize: 256,
  });
  const competingJson = JSON.stringify(competingEvent);
  const insert = writerDb.prepare(
    "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  return {
    inject: () => insert.run(sessionId, 2, competingEvent.runId ?? null, competingJson, Date.now()),
    close: () => writerDb.close(),
  };
}

describe("SQLite trajectory runtime reader snapshot consistency", () => {
  let tempDir: string;
  let storePath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-sqlite-snapshot-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await replaceSessionEntry(
      { sessionKey: "agent:main:session-1", storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
    dbPath = path.join(tempDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the production reader's budget aggregate and payload SELECT in one deferred snapshot so a competing writer cannot cross the budget", () => {
    // Seed one row within a tight byte budget.
    const event = createTrajectoryEvent({ seq: 1, type: "snapshot-row-1", payloadSize: 100 });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    // Borrow the process-cached agent database so the production reader reuses
    // this connection (withOpenClawAgentDatabaseReadOnly borrows when not in a
    // transaction). Spying on its prepare() lets us detect the payload SELECT
    // and inject a competing row between admission and materialization — the
    // same native-statement instrumentation pattern used by the trim test above.
    const database = openOpenClawAgentDatabase({ agentId: "main", path: dbPath });
    const injector = createCompetingRowInjector(dbPath, "session-1");
    const prepare = database.db.prepare.bind(database.db);
    let injected = false;
    const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      // The payload SELECT fetches "seq" and "event_json" with an ORDER BY;
      // the budget aggregate uses SUM(OCTET_LENGTH). Inject exactly once,
      // after the budget check passes and before rows are iterated.
      if (!injected && sql.includes(`"seq", "event_json"`)) {
        injector.inject();
        injected = true;
      }
      return statement;
    });

    try {
      // Call the production reader with a budget that exactly fits the seeded
      // row. The deferred transaction snapshot prevents the competing row
      // (inserted between admission and materialization) from being visible.
      const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
        sessionId: "session-1",
        storePath,
        maxEventBytes: rowBytes,
      });

      expect(rows.map((row) => row.event.type)).toEqual(["snapshot-row-1"]);
      expect(injected).toBe(true);
    } finally {
      prepareSpy.mockRestore();
      injector.close();
    }
  });

  it("admits a within-budget two-row read at the exact byte boundary via the production reader", () => {
    const event = createTrajectoryEvent({ seq: 1, type: "admit-row-1", payloadSize: 100 });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }, [event]);
    const rowBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    const secondEvent = createTrajectoryEvent({
      seq: 2,
      type: "admit-row-2",
      payloadSize: 100,
    });
    const writerDb = openNodeSqliteDatabase(dbPath);
    writerDb
      .prepare(
        "INSERT INTO trajectory_runtime_events (session_id, seq, run_id, event_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("session-1", 1, secondEvent.runId ?? null, JSON.stringify(secondEvent), Date.now());
    writerDb.close();

    const secondRowBytes = Buffer.byteLength(JSON.stringify(secondEvent), "utf8");
    const totalBudget = rowBytes + 1 + secondRowBytes; // 2 rows + 1 JSONL separator

    const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
      sessionId: "session-1",
      storePath,
      maxEventBytes: totalBudget,
    });

    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.event.type)).toEqual(["admit-row-1", "admit-row-2"]);
  });
});
