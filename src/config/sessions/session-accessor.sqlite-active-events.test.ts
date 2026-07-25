// Active transcript projection tests cover branch rebuilds and bounded large-history reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptActiveLeafEvents,
  readSessionTranscriptMessageAnchorPage,
  readSessionTranscriptMessageEventById,
  readSessionTranscriptMessageEventCount,
  readSessionTranscriptMessageEventPage,
  SessionTranscriptProjectionUnavailableError,
} from "./session-accessor.sqlite-active-events.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const queuedSessionWrite = vi.hoisted(() => vi.fn());

vi.mock("../../shared/store-writer-queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/store-writer-queue.js")>();
  return {
    ...actual,
    runQueuedStoreWrite: async (
      params: Parameters<typeof actual.runQueuedStoreWrite>[0],
    ): Promise<unknown> => {
      queuedSessionWrite();
      return await actual.runQueuedStoreWrite(params);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite active transcript event projection", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    queuedSessionWrite.mockReset();
    stateDir = tempDirs.make("openclaw-active-transcript-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "active-transcript-test",
      sessionKey: "agent:main:active-transcript-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("defers branch rewind rebuilds off history and writer stacks", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        },
        {
          eventId: "inactive",
          parentId: "root",
          message: { role: "assistant", content: "inactive" },
        },
        {
          eventId: "active",
          parentId: "root",
          message: { role: "assistant", content: "active" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });

    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 2, needs_rebuild: 1 });

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "root",
      "active",
    ]);
    expect(readSessionTranscriptActiveLeafEvents(scope)).toEqual([
      expect.objectContaining({ id: "active" }),
    ]);
    expect(page.events.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(page.totalMessages).toBe(2);
    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_event_count, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_event_count: 2, active_message_count: 2, needs_rebuild: 0 });
    expect(
      database.db
        .prepare(
          "SELECT active_position, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
    ).toEqual([
      { active_position: 0, event_seq: 1, message_position: 0 },
      { active_position: 1, event_seq: 3, message_position: 1 },
    ]);
  });

  it("defers mixed legacy and canonical rebuilds off request stacks", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "canonical-root",
          parentId: null,
          message: { role: "user", content: "canonical" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });

    await appendTranscriptEvent(scope, {
      id: "legacy-child",
      parentId: "canonical-root",
      message: { role: "assistant", content: "legacy" },
    });

    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 1, needs_rebuild: 1 });

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.totalMessages).toBe(1);
    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "canonical-root",
    ]);
    expect(readSessionTranscriptMessageEventById(scope, "legacy-child")).toBeUndefined();
    expect(
      database.db
        .prepare(
          "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ active_message_count: 1, needs_rebuild: 0 });
  });

  it("fails fast and schedules maintenance when out-of-band state is dirty", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "user", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 1 });

    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 0 });
  });

  it("projects reset kept-tail and post-boundary messages without rewriting raw positions", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          eventId: "kept-tool",
          parentId: "kept-user",
          message: { role: "toolResult", content: `hidden tool ${"x".repeat(2_000)}` },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-tool",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });

    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);
    expect(page.events.map((entry) => entry.seq)).toEqual([2, 4, 5]);
    expect(page.totalMessages).toBe(3);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(3);
    expect(readSessionTranscriptMessageEventById(scope, "old")).toBeUndefined();
    expect(readSessionTranscriptMessageEventById(scope, "kept-tool")).toBeUndefined();

    const recent = readRecentSessionTranscriptMessageEvents(scope, {
      maxBytes: 1_024,
      maxLines: 10,
      maxMessages: 3,
    });
    expect(recent.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
    ]);

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "newer-compaction",
      parentId: "post-reset",
      timestamp: "2026-07-22T00:01:00.000Z",
      summary: "newer boundary shadows reset",
      firstKeptEntryId: "old",
      tokensBefore: 10,
    });
    expect(
      readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1_024,
        maxLines: 1,
        maxMessages: 1,
      }).activeLeafEntryId,
    ).toBe("newer-compaction");
    expect(readSessionTranscriptActiveLeafEvents(scope)).toEqual([
      expect.objectContaining({ id: "newer-compaction" }),
    ]);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(5);
    expect(readSessionTranscriptMessageEventById(scope, "old")).toBeDefined();
  });

  it("recomputes a cached reset window after a branch-changing message", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept" },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-user",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "post reset" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(3);

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "branch-message",
          parentId: "old",
          message: { role: "assistant", content: "branched" },
        },
      ],
      touchSessionEntry: false,
    });
    await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId, env: scope.env });

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });
    expect(page.events.map((entry) => (entry.event as { id?: unknown }).id)).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
      "branch-message",
    ]);
  });

  it("reconciles work scheduled while an earlier pass is yielding", async () => {
    const secondScope = { ...scope, sessionId: "session-2", sessionKey: "agent:main:second" };
    for (const target of [scope, secondScope]) {
      await persistSessionTranscriptTurn(target, {
        messages: [
          {
            eventId: `${target.sessionId}-seed`,
            parentId: null,
            message: { role: "user", content: target.sessionId },
          },
        ],
        touchSessionEntry: false,
      });
    }
    const databaseOptions = { agentId: scope.agentId, env: scope.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const markDirty = (sessionId: string) =>
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);

    markDirty(scope.sessionId);
    startSessionTranscriptIndexReconcile({
      ...databaseOptions,
      preferredSessionId: scope.sessionId,
    });
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        markDirty(secondScope.sessionId);
        startSessionTranscriptIndexReconcile({
          ...databaseOptions,
          preferredSessionId: secondScope.sessionId,
        });
        resolve();
      });
    });
    await waitForSessionTranscriptIndexReconcile(databaseOptions);

    expect(
      database.db
        .prepare(
          "SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0 ORDER BY session_id",
        )
        .all(),
    ).toEqual([]);
  });

  it("keeps projection state and rows on one snapshot during a concurrent append", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "toolResult", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const state = database.db
      .prepare(
        `
          SELECT indexed_seq, active_event_count, active_message_count
          FROM session_transcript_index_state
          WHERE session_id = ?
        `,
      )
      .get(scope.sessionId) as {
      active_event_count: number;
      active_message_count: number;
      indexed_seq: number;
    };
    const nextSeq = state.indexed_seq + 1;
    const appendedEvent = {
      type: "message",
      id: "concurrent",
      parentId: "seed",
      message: { role: "toolResult", content: "concurrent" },
    };
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
    let appended = false;
    const options = {
      maxBytes: 1024 * 1024,
      maxLines: 10,
      get maxMessages() {
        if (!appended) {
          appended = true;
          writer.exec("BEGIN IMMEDIATE;");
          try {
            writer
              .prepare(
                `
                  INSERT INTO transcript_events (session_id, seq, event_json, created_at)
                  VALUES (?, ?, ?, ?)
                `,
              )
              .run(scope.sessionId, nextSeq, JSON.stringify(appendedEvent), Date.now());
            writer
              .prepare(
                `
                  INSERT INTO transcript_event_identities
                    (session_id, event_id, seq, event_type, parent_id,
                     message_idempotency_key, created_at)
                  VALUES (?, 'concurrent', ?, 'message', 'seed', NULL, ?)
                `,
              )
              .run(scope.sessionId, nextSeq, Date.now());
            writer
              .prepare(
                `
                  INSERT INTO session_transcript_active_events
                    (session_id, active_position, event_seq, message_position)
                  VALUES (?, ?, ?, ?)
                `,
              )
              .run(scope.sessionId, state.active_event_count, nextSeq, state.active_message_count);
            writer
              .prepare(
                `
                  UPDATE session_transcript_index_state
                  SET indexed_seq = ?, leaf_event_id = 'concurrent', needs_rebuild = 0,
                      active_event_count = active_event_count + 1,
                      active_message_count = active_message_count + 1,
                      updated_at = ?
                  WHERE session_id = ?
                `,
              )
              .run(nextSeq, Date.now(), scope.sessionId);
            writer.exec("COMMIT;");
          } catch (error) {
            writer.exec("ROLLBACK;");
            throw error;
          }
        }
        return 10;
      },
    };

    try {
      const concurrentRead = readRecentSessionTranscriptMessageEvents(scope, options);
      expect(concurrentRead.totalMessages).toBe(1);
      expect(concurrentRead.events.map((entry) => (entry.event as { id?: string }).id)).toEqual([
        "seed",
      ]);

      const afterCommit = readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1024 * 1024,
        maxLines: 10,
        maxMessages: 10,
      });
      expect(afterCommit.totalMessages).toBe(2);
      expect(afterCommit.events.map((entry) => (entry.event as { id?: string }).id)).toEqual([
        "seed",
        "concurrent",
      ]);
    } finally {
      writer.close();
    }
  });

  it("awaits queued completion work after the preparation worker exits", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "seed", message: { role: "user", content: "seed" } }],
      touchSessionEntry: false,
    });
    let resolveCompletionQueued!: () => void;
    const completionQueued = new Promise<void>((resolve) => {
      resolveCompletionQueued = resolve;
    });
    queuedSessionWrite.mockImplementation(() => {
      if (queuedSessionWrite.mock.calls.length === 2) {
        resolveCompletionQueued();
      }
    });
    let releaseWriter!: () => void;
    let writerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      writerEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const heldWriter = runExclusiveSqliteSessionWrite(
      { agentId: scope.agentId, env: scope.env },
      async () => {
        writerEntered();
        await release;
      },
    );
    await entered;
    const outcome = reconcileSessionTranscriptIndexes({
      agentId: scope.agentId,
      env: scope.env,
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    // The second queued write is the orphan sweep issued after the worker's done message.
    await completionQueued;
    expect(queuedSessionWrite).toHaveBeenCalledTimes(2);
    releaseWriter();
    await heldWriter;

    expect(await outcome).toEqual({ value: { reconciledSessions: 0 } });
  }, 10_000);

  it("keeps dirty batch appends off the synchronous writer stack", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "root", message: { role: "user", content: "root" } }],
      touchSessionEntry: false,
    });
    const databaseOptions = { agentId: scope.agentId, env: scope.env };
    const database = openOpenClawAgentDatabase(databaseOptions);
    const original = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 1")
      .get(scope.sessionId) as { event_json: string };
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
      .run(scope.sessionId);

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      expect(
        appendTranscriptEventsInTransaction(writeDatabase, scope, [
          { type: "leaf", id: "batch-leaf", parentId: "root", targetId: "root" },
        ]),
      ).toBe(1);
    }, databaseOptions);
    database.db
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
      .run(original.event_json, scope.sessionId);

    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 1 });
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);
  });

  it("keeps 100k-message reads bounded while rebuilds yield to live writes", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          message: { role: "toolResult", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const insertEvent = database.db.prepare(`
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertIdentity = database.db.prepare(`
      INSERT INTO transcript_event_identities
        (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
      VALUES (?, ?, ?, 'message', ?, NULL, ?)
    `);
    const insertActive = database.db.prepare(`
      INSERT INTO session_transcript_active_events
        (session_id, active_position, event_seq, message_position)
      VALUES (?, ?, ?, ?)
    `);
    database.db.exec("BEGIN IMMEDIATE;");
    try {
      database.db
        .prepare("DELETE FROM session_transcript_fts WHERE session_id = ?")
        .run(scope.sessionId);
      database.db
        .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
        .run(scope.sessionId);
      database.db
        .prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
        .run(scope.sessionId);
      database.db
        .prepare("DELETE FROM transcript_events WHERE session_id = ?")
        .run(scope.sessionId);
      insertEvent.run(
        scope.sessionId,
        0,
        JSON.stringify({ id: scope.sessionId, type: "session", version: 3 }),
        0,
      );
      // Cardinality and parent links drive this bound; keep unrelated payload bytes minimal.
      for (let index = 1; index <= 100_000; index += 1) {
        const eventId = `m${index}`;
        const parentId = index === 1 ? null : `m${index - 1}`;
        insertEvent.run(
          scope.sessionId,
          index,
          JSON.stringify({
            type: "message",
            id: eventId,
            parentId,
            message: { role: "toolResult", content: "x" },
          }),
          index,
        );
        insertIdentity.run(scope.sessionId, eventId, index, parentId, index);
        insertActive.run(scope.sessionId, index - 1, index, index - 1);
      }
      database.db
        .prepare(
          `
            INSERT INTO session_transcript_index_state
              (session_id, indexed_seq, leaf_event_id, needs_rebuild,
               active_event_count, active_message_count, updated_at)
            VALUES (?, 100000, 'm100000', 0, 100000, 100000, 100000)
          `,
        )
        .run(scope.sessionId);
      database.db.exec("COMMIT;");
    } catch (error) {
      database.db.exec("ROLLBACK;");
      throw error;
    }

    // Parse sentinel: any accidental full materialization fails before reaching the bounded tail.
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1")
      .run(scope.sessionId);

    const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 25, offset: 0 });
    const recent = readRecentSessionTranscriptMessageEvents(scope, {
      maxBytes: 1024 * 1024,
      maxLines: 10,
      maxMessages: 10,
    });
    const lineCappedRecent = readRecentSessionTranscriptMessageEvents(scope, {
      maxBytes: 1024 * 1024,
      maxLines: 3,
      maxMessages: 10,
    });
    const byId = readSessionTranscriptMessageEventById(scope, "m100000");
    const anchor = readSessionTranscriptMessageAnchorPage(scope, {
      maxMessages: 5,
      messageId: "m100000",
    });

    expect(page.totalMessages).toBe(100_000);
    expect(page.events).toHaveLength(25);
    expect(page.events.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 25 }, (_, index) => 99_976 + index),
    );
    expect(recent.totalMessages).toBe(100_000);
    expect(recent.events).toHaveLength(10);
    expect(recent.events.at(-1)?.seq).toBe(100_000);
    expect(lineCappedRecent.events).toHaveLength(3);
    expect(lineCappedRecent.events.at(-1)?.seq).toBe(100_000);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(100_000);
    expect(byId?.seq).toBe(100_000);
    expect(anchor).toMatchObject({
      found: true,
      hasOverreadContext: true,
      offset: 0,
      totalMessages: 100_000,
    });
    expect(anchor.events).toHaveLength(6);
    expect(anchor.events.at(-1)?.seq).toBe(100_000);

    database.db
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
      .run(
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          message: { role: "toolResult", content: "x" },
        }),
        scope.sessionId,
      );
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);

    expect(() => readSessionTranscriptMessageEventCount(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    const order: string[] = [];
    const reconciliation = waitForSessionTranscriptIndexReconcile({
      agentId: scope.agentId,
      env: scope.env,
    }).then(() => order.push("reconciled"));
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        setTimeout(() => {
          order.push("event-loop-responsive");
          resolve();
        }, 0);
      });
    });
    expect(order).toEqual(["event-loop-responsive"]);
    const liveWrite = await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "m100001",
          parentId: "m100000",
          message: { role: "toolResult", content: "live-write" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(liveWrite.appendedCount).toBe(1);
    order.push("live-write");
    await reconciliation;
    expect(order).toEqual(["event-loop-responsive", "live-write", "reconciled"]);
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(100_001);
  }, 60_000);
});
