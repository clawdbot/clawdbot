import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  acknowledgeSessionStateNotices,
  classifySessionStateActor,
  getSessionStateVersion,
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
  listSessionStateEventsSince,
  recordSessionCompacted,
  recordSessionGoalChanged,
  recordSessionHumanDirectMessage,
  recordSessionStateEvent,
  recordSubagentSpawned,
  recordSubagentTerminalState,
  registerSessionStateWatch,
  sweepSessionStateWatchNotices,
} from "./session-state-events.js";

const SESSION_STATE_MAX_ROWS = 50_000;
const SESSION_STATE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const tempDirs: string[] = [];
const watcher = "agent:main:main";
const nestedWatcher = "agent:main:subagent:parent";
const child = "agent:main:subagent:child";
const cfg = {} as OpenClawConfig;
let disposeHeartbeatWakeHandler: (() => void) | undefined;

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-state-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function eventInput(
  overrides: Partial<Parameters<typeof recordSessionStateEvent>[0]> = {},
): Parameters<typeof recordSessionStateEvent>[0] {
  return {
    sessionKey: child,
    sessionId: "session-child",
    agentId: "main",
    kind: "human_direct_message",
    actorType: "human",
    summary: "human message via test",
    watcherSessionKeys: [watcher],
    ...overrides,
  };
}

function readCursor(
  database: ReturnType<typeof createDatabaseOptions>,
  watcherSessionKey = watcher,
) {
  return openOpenClawStateDatabase(database)
    .db.prepare(
      `SELECT last_seen_sequence, notified_sequence, material_sequence
       FROM session_watch_cursors
       WHERE watcher_session_key = ? AND target_session_key = ?`,
    )
    .get(watcherSessionKey, child) as
    | {
        last_seen_sequence: number;
        notified_sequence: number;
        material_sequence: number;
      }
    | undefined;
}

function seedChild(
  database: ReturnType<typeof createDatabaseOptions>,
  watcherSessionKey = watcher,
) {
  return recordSessionStateEvent(
    eventInput({
      kind: "child_spawned",
      actorType: "agent",
      actorId: watcherSessionKey,
      dedupeKey: `child-spawned:${watcherSessionKey}`,
      watcherSessionKeys: [watcherSessionKey],
    }),
    database,
  );
}

async function createWatcherSession(
  database: ReturnType<typeof createDatabaseOptions>,
  watcherSessionKey = watcher,
) {
  await upsertSessionEntry(
    { sessionKey: watcherSessionKey, env: database.env },
    { sessionId: `session-${watcherSessionKey}`, updatedAt: Date.now() },
  );
}

afterEach(() => {
  disposeHeartbeatWakeHandler?.();
  disposeHeartbeatWakeHandler = undefined;
  closeOpenClawStateDatabaseForTest();
  resetSystemEventsForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session state events", () => {
  it("bumps a durable head that survives pruning all retained rows", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const event = recordSessionStateEvent(eventInput(), { ...database, now });
    expect(getSessionStateVersion(child, "main", database)).toBe(event?.sequence);

    sweepSessionStateWatchNotices({
      ...database,
      now: now + SESSION_STATE_RETENTION_MS + 1,
    });

    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toEqual([]);
    expect(getSessionStateVersion(child, "main", database)).toBe(event?.sequence);
  });

  it("freezes one notice watermark while material events continue", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const first = recordSessionStateEvent(eventInput(), database)!;
    recordSessionStateEvent(eventInput(), database);
    const third = recordSessionStateEvent(eventInput(), database)!;

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: first.sequence - 1,
      notified_sequence: first.sequence,
      material_sequence: third.sequence,
    });
  });

  it("opens a fresh notice for material work interleaved before ack", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const frozen = recordSessionStateEvent(eventInput(), database)!;
    const interleaved = recordSessionStateEvent(eventInput(), database)!;
    resetSystemEventsForTest();

    acknowledgeSessionStateNotices(watcher, [child], database);

    expect(readCursor(database)).toEqual({
      last_seen_sequence: frozen.sequence,
      notified_sequence: interleaved.sequence,
      material_sequence: interleaved.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(`changesSince ${frozen.sequence}`);
  });

  it("does not reopen an acked notice for log-only events or during sweep", async () => {
    const database = createDatabaseOptions();
    await createWatcherSession(database);
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    recordSessionStateEvent(
      eventInput({ kind: "run_completed", actorType: "system", runId: "run-log-only" }),
      database,
    );
    resetSystemEventsForTest();

    acknowledgeSessionStateNotices(watcher, [child], database);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: material.sequence,
      notified_sequence: material.sequence,
      material_sequence: material.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toEqual([]);

    sweepSessionStateWatchNotices(database);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("wakes main watchers but only queues notices for nested watchers", async () => {
    vi.useFakeTimers();
    const wakes = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    disposeHeartbeatWakeHandler = setHeartbeatWakeHandler(wakes);
    // Drain notices queued by earlier tests before checking this watcher's routing.
    await vi.advanceTimersByTimeAsync(300);
    wakes.mockClear();
    const database = createDatabaseOptions();
    seedChild(database, nestedWatcher);

    recordSessionStateEvent(eventInput({ watcherSessionKeys: [nestedWatcher] }), database);
    await vi.advanceTimersByTimeAsync(300);
    expect(peekSystemEventEntries(nestedWatcher)).toHaveLength(1);
    expect(wakes).not.toHaveBeenCalled();

    seedChild(database, watcher);
    recordSessionStateEvent(eventInput(), database);
    await vi.advanceTimersByTimeAsync(300);
    expect(wakes).toHaveBeenCalledWith(
      // intent "immediate" is load-bearing: event-intent wakes defer on heartbeat
      // dueness and would sit on the notice until the next scheduled tick.
      expect.objectContaining({
        source: "session-state",
        sessionKey: watcher,
        intent: "immediate",
      }),
    );
  });

  it("suppresses watcher-originated material events", () => {
    const database = createDatabaseOptions();
    const seeded = seedChild(database)!;
    recordSessionStateEvent(eventInput({ actorType: "agent", actorId: watcher }), database);

    expect(readCursor(database)).toEqual({
      last_seen_sequence: seeded.sequence,
      notified_sequence: seeded.sequence,
      material_sequence: seeded.sequence,
    });
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("records log-only kinds without queueing notices", () => {
    const database = createDatabaseOptions();
    const event = recordSessionStateEvent(
      eventInput({ kind: "compacted", actorType: "system" }),
      database,
    );

    expect(getSessionStateVersion(child, "main", database)).toBe(event?.sequence);
    expect(peekSystemEventEntries(watcher)).toEqual([]);
  });

  it("notifies watchers when an upstream session disappears", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    resetSystemEventsForTest();

    const event = recordSessionStateEvent(
      eventInput({ kind: "upstream_missing", actorType: "system" }),
      database,
    );

    expect(event).toMatchObject({ kind: "upstream_missing", actorType: "system" });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("returns the existing row for a duplicate dedupe key", () => {
    const database = createDatabaseOptions();
    const input = eventInput({
      kind: "run_failed",
      actorType: "system",
      runId: "run-1",
      dedupeKey: "run-terminal:run-1",
    });
    const first = recordSessionStateEvent(input, database);
    const duplicate = recordSessionStateEvent(input, database);

    expect(duplicate?.sequence).toBe(first?.sequence);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toHaveLength(1);
  });

  it("re-enqueues and re-freezes pending notices after restart", async () => {
    const database = createDatabaseOptions();
    await createWatcherSession(database);
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    resetSystemEventsForTest();

    sweepSessionStateWatchNotices(database);

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(readCursor(database)?.notified_sequence).toBe(material.sequence);
  });

  it("self-heals a lost queued notice on the next material event", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    recordSessionStateEvent(eventInput(), database);
    resetSystemEventsForTest();

    recordSessionStateEvent(eventInput(), database);

    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("prunes retention and cap rows while keeping monotonic autoincrement heads", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const { db } = openOpenClawStateDatabase(database);
    db.exec(`
      WITH RECURSIVE rows(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM rows WHERE value <= ${SESSION_STATE_MAX_ROWS}
      )
      INSERT INTO session_state_events (
        session_key, agent_id, kind, actor_type, occurred_at, summary
      )
      SELECT 'bulk', 'main', 'compacted', 'system', ${now}, 'bulk' FROM rows;
    `);
    const before = db
      .prepare("SELECT max(sequence) AS sequence FROM session_state_events")
      .get() as { sequence: number };

    sweepSessionStateWatchNotices({ ...database, now });
    const count = db.prepare("SELECT count(*) AS count FROM session_state_events").get() as {
      count: number;
    };
    expect(count.count).toBe(SESSION_STATE_MAX_ROWS);

    const next = recordSessionStateEvent(eventInput(), { ...database, now: now + 1 })!;
    expect(next.sequence).toBeGreaterThan(before.sequence);
    expect(getSessionStateVersion(child, "main", database)).toBe(next.sequence);
  });

  it("lists typed ascending deltas with truncation and history-gap signaling", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    const first = recordSessionStateEvent(eventInput({ summary: "first" }), {
      ...database,
      now,
    })!;
    recordSessionStateEvent(eventInput({ summary: "second", payload: { status: "active" } }), {
      ...database,
      now: now + 1,
    });
    recordSessionStateEvent(eventInput({ summary: "third" }), { ...database, now: now + 2 });

    const page = listSessionStateEventsSince(child, "main", 0, 2, database);
    expect(page.events.map((event) => event.summary)).toEqual(["first", "second"]);
    expect(page.events[1]?.payload).toEqual({ status: "active" });
    expect(page.truncated).toBe(true);

    // A manually removed row is not a retention gap: only pruning stamps the
    // per-session watermark that historyGap may consult.
    openOpenClawStateDatabase(database)
      .db.prepare("DELETE FROM session_state_events WHERE sequence = ?")
      .run(first.sequence);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).historyGap).toBe(false);
  });

  it("reports history gaps only for actually pruned events, not sparse global sequences", () => {
    const database = createDatabaseOptions();
    const now = Date.now();
    // Other sessions consume early global sequences; the child starts high.
    for (let index = 0; index < 3; index += 1) {
      recordSessionStateEvent(
        eventInput({ sessionKey: "agent:main:subagent:noise", watcherSessionKeys: [] }),
        { ...database, now },
      );
    }
    const old = recordSessionStateEvent(eventInput({ summary: "old" }), { ...database, now })!;
    expect(old.sequence).toBeGreaterThan(1);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).historyGap).toBe(false);

    const later = now + SESSION_STATE_RETENTION_MS + 1;
    const fresh = recordSessionStateEvent(eventInput({ summary: "fresh" }), {
      ...database,
      now: later,
    })!;
    sweepSessionStateWatchNotices({ ...database, now: later });

    const sincePruned = listSessionStateEventsSince(child, "main", 0, 200, database);
    expect(sincePruned.historyGap).toBe(true);
    expect(sincePruned.events.map((event) => event.summary)).toEqual(["fresh"]);
    expect(listSessionStateEventsSince(child, "main", old.sequence, 200, database).historyGap).toBe(
      false,
    );
    expect(getSessionStateVersion(child, "main", database)).toBe(fresh.sequence);
  });

  it("suppresses cursors and notices for agent-ambiguous bare watcher keys", () => {
    const database = createDatabaseOptions();
    const event = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: ["global"] }),
      database,
    )!;
    expect(event.sequence).toBeGreaterThan(0);
    expect(peekSystemEventEntries("global")).toEqual([]);
    const cursorRow = openOpenClawStateDatabase(database)
      .db.prepare("SELECT COUNT(*) AS n FROM session_watch_cursors")
      .get() as { n: number };
    expect(cursorRow.n).toBe(0);
  });

  it("keeps same-keyed global sessions independent across agents", () => {
    const database = createDatabaseOptions();
    const mainEvent = recordSessionStateEvent(
      eventInput({
        sessionKey: "global",
        agentId: "main",
        kind: "goal_changed",
        actorType: "human",
        watcherSessionKeys: [],
      }),
      database,
    )!;
    const opsEvent = recordSessionStateEvent(
      eventInput({
        sessionKey: "global",
        agentId: "ops",
        kind: "goal_changed",
        actorType: "human",
        watcherSessionKeys: [],
      }),
      database,
    )!;

    expect(getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
    expect(getSessionStateVersion("global", "ops", database)).toBe(opsEvent.sequence);
    expect(
      listSessionStateEventsSince("global", "main", 0, 200, database).events.map(
        (event) => event.sequence,
      ),
    ).toEqual([mainEvent.sequence]);

    handleSessionStateSessionDeleted("global", "ops", database);
    expect(getSessionStateVersion("global", "ops", database)).toBe(0);
    expect(getSessionStateVersion("global", "main", database)).toBe(mainEvent.sequence);
  });

  it("acks only drained session-state entries and ignores ordinary events", async () => {
    const database = createDatabaseOptions();
    seedChild(database);
    const material = recordSessionStateEvent(eventInput(), database)!;
    enqueueSystemEvent("Cron completed", { sessionKey: watcher, contextKey: "cron:job-1" });

    await drainFormattedSystemEvents({
      cfg,
      sessionKey: watcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(readCursor(database)?.last_seen_sequence).toBe(material.sequence);

    recordSessionStateEvent(eventInput(), database);
    resetSystemEventsForTest();
    enqueueSystemEvent("Exec completed", { sessionKey: watcher, contextKey: "exec:job-1" });
    await drainFormattedSystemEvents({
      cfg,
      sessionKey: watcher,
      isMainSession: false,
      isNewSession: false,
    });
    expect(readCursor(database)?.last_seen_sequence).toBe(material.sequence);
  });

  it("keeps target history on reset and removes all ownership on delete", () => {
    const database = createDatabaseOptions();
    seedChild(database);
    recordSessionStateEvent(eventInput(), database);

    handleSessionStateSessionReset(watcher, database);
    expect(readCursor(database)).toBeUndefined();
    expect(
      listSessionStateEventsSince(child, "main", 0, 200, database).events.length,
    ).toBeGreaterThan(0);

    handleSessionStateSessionDeleted(child, "main", database);
    expect(getSessionStateVersion(child, "main", database)).toBe(0);
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toEqual([]);
  });

  it("classifies missing provenance as human and inter-session provenance as agent", () => {
    expect(classifySessionStateActor({})).toEqual({ actorType: "human" });
    expect(
      classifySessionStateActor({
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:source",
        },
      }),
    ).toEqual({ actorType: "agent", actorId: "agent:main:source" });
    expect(classifySessionStateActor({ internalEvents: [{}] })).toEqual({
      actorType: "system",
    });
  });

  it("registers explicit watchers who get notices only for later changes", () => {
    const database = createDatabaseOptions();
    const preRegistration = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: [] }),
      database,
    )!;

    expect(registerSessionStateWatch({ watcherSessionKey: child, targetSessionKey: child })).toBe(
      false,
    );
    expect(
      registerSessionStateWatch({ watcherSessionKey: "global", targetSessionKey: child }),
    ).toBe(false);
    expect(
      registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database),
    ).toBe(true);

    expect(peekSystemEventEntries(watcher)).toHaveLength(0);
    expect(readCursor(database)).toMatchObject({ last_seen_sequence: preRegistration.sequence });

    const afterRegistration = recordSessionStateEvent(
      eventInput({ watcherSessionKeys: [] }),
      database,
    )!;
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
    expect(peekSystemEventEntries(watcher)[0]?.text).toContain(
      `changesSince ${preRegistration.sequence}`,
    );

    // Re-registering must keep the pending-notice cursor intact.
    expect(
      registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database),
    ).toBe(true);
    expect(readCursor(database)).toEqual({
      last_seen_sequence: preRegistration.sequence,
      notified_sequence: afterRegistration.sequence,
      material_sequence: afterRegistration.sequence,
    });
  });

  it("gates unparented human turns on registered watchers", () => {
    const database = createDatabaseOptions();
    const entry = { sessionId: "session-child", updatedAt: Date.now() };
    recordSessionHumanDirectMessage({
      sessionKey: child,
      entry,
      agentId: "main",
      actor: { actorType: "human" },
      channel: "webchat",
    });
    expect(listSessionStateEventsSince(child, "main", 0, 200, database).events).toHaveLength(0);

    registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: child }, database);
    recordSessionHumanDirectMessage({
      sessionKey: child,
      entry,
      agentId: "main",
      actor: { actorType: "human" },
      channel: "webchat",
    });

    const events = listSessionStateEventsSince(child, "main", 0, 200, database).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "human_direct_message" });
    expect(peekSystemEventEntries(watcher)).toHaveLength(1);
  });

  it("projects spawn, terminal, goal, and compaction producer helpers", () => {
    const database = createDatabaseOptions();
    recordSubagentSpawned({
      childSessionKey: child,
      childRunId: "run-child",
      requesterSessionKey: watcher,
      agentId: "main",
    });
    recordSubagentTerminalState({
      childSessionKey: child,
      runId: "run-child",
      requesterSessionKey: watcher,
      outcomeStatus: "ok",
    });
    recordSubagentTerminalState({
      childSessionKey: child,
      runId: "run-child",
      requesterSessionKey: watcher,
      outcomeStatus: "ok",
    });
    recordSubagentTerminalState({
      childSessionKey: child,
      runId: "run-child-cancelled",
      requesterSessionKey: watcher,
      outcomeStatus: "cancelled",
    });
    recordSessionGoalChanged({
      sessionKey: child,
      entry: {
        sessionId: "session-child",
        updatedAt: Date.now(),
        spawnedBy: watcher,
      },
      actor: { type: "human" },
      summary: "goal created",
    });
    recordSessionCompacted({
      sessionKey: child,
      operationId: "compact-1",
      sessionId: "session-child",
    });
    recordSessionCompacted({
      sessionKey: child,
      operationId: "compact-1",
      sessionId: "session-child",
    });

    const events = listSessionStateEventsSince(child, "main", 0, 200, database).events;
    expect(events.map((event) => event.kind)).toEqual([
      "child_spawned",
      "run_completed",
      "run_failed",
      "goal_changed",
      "compacted",
    ]);
    expect(events[2]).toMatchObject({
      runId: "run-child-cancelled",
      summary: "child run cancelled",
      payload: { outcome: "cancelled" },
    });
  });
});
