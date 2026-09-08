import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  prepareSqliteTranscriptSuffixMutation,
  replaceSqliteTranscriptSuffixInTransaction,
} from "./session-accessor.sqlite-transcript-suffix.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const rewriteEvents = [
  { type: "custom", id: "root", parentId: null },
  { type: "message", id: "user", parentId: "root", message: { role: "user", content: "question" } },
  {
    type: "message",
    id: "answer",
    parentId: "user",
    message: { role: "assistant", content: "answer" },
  },
] as const;

async function withRewriteFixture(
  run: (fixture: {
    db: ReturnType<typeof openOpenClawAgentDatabase>["db"];
    snapshot: () => {
      raw: Array<Record<string, unknown>>;
      identities: unknown[];
      active: unknown[];
      search: unknown[];
      generation: string | undefined;
      updatedAt: number | null;
    };
    scope: { agentId: string; sessionId: string; sessionKey: string; env: NodeJS.ProcessEnv };
  }) => void | Promise<void>,
  events: readonly unknown[] = rewriteEvents,
): Promise<void> {
  await withOpenClawTestState({ label: "exact-suffix-rewrite" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "rewrite",
      sessionKey: "agent:main:rewrite",
      env: state.env,
    };
    const owner = openOpenClawAgentDatabase(scope);
    const { db } = owner;
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventsInTransaction(database, scope, events);
    }, scope);
    const snapshot = () => ({
      raw: db
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      active: db
        .prepare(
          "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
      search: db
        .prepare("SELECT * FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id")
        .all(scope.sessionId),
      generation: readTranscriptGenerationInTransaction(owner, scope.sessionId),
      updatedAt: readTranscriptMutationStateInTransaction(owner, scope.sessionId).updatedAt,
    });
    await run({ db, snapshot, scope });
  });
}

function replaceTranscriptSuffixForTest(
  scope: { agentId: string; sessionId: string; sessionKey: string; env: NodeJS.ProcessEnv },
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
  persistedPrefixLength = 0,
): void {
  const owner = openOpenClawAgentDatabase(scope);
  const plan = prepareSqliteTranscriptSuffixMutation(
    owner,
    scope,
    expectedEvents,
    nextEvents,
    persistedPrefixLength,
  );
  runOpenClawAgentWriteTransaction((database) => {
    replaceSqliteTranscriptSuffixInTransaction(database, scope, plan);
  }, scope);
}

describe("SQLite exact transcript suffix replacement", () => {
  it("rejects a changed mutation fence while planning an incremental suffix", async () => {
    await withRewriteFixture(({ db, scope }) => {
      clearNodeSqliteKyselyCacheForDatabase(db);
      const originalPrepare = db.prepare.bind(db);
      let changedFence = false;
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sqlText: string) => {
        if (
          !changedFence &&
          sqlText.toLowerCase().includes("session_transcript_active_events") &&
          sqlText.toLowerCase().includes("event_seq")
        ) {
          originalPrepare(
            `UPDATE session_windows
             SET transcript_updated_at = transcript_updated_at + 1
             WHERE session_id = ?`,
          ).run(scope.sessionId);
          changedFence = true;
        }
        return originalPrepare(sqlText);
      });
      try {
        expect(() =>
          prepareSqliteTranscriptSuffixMutation(
            openOpenClawAgentDatabase(scope),
            scope,
            rewriteEvents,
            rewriteEvents.slice(0, -1),
            rewriteEvents.length - 1,
          ),
        ).toThrow(`SQLite transcript changed while planning suffix removal for ${scope.sessionId}`);
      } finally {
        prepareSpy.mockRestore();
      }
      expect(changedFence).toBe(true);
    });
  });

  it("reconciles after removing a suffix anchored on an inactive branch", async () => {
    const events = [
      rewriteEvents[0],
      rewriteEvents[1],
      {
        type: "message",
        id: "inactive-parent",
        parentId: "root",
        appendMode: "side",
        message: { role: "assistant", content: "inactive parent" },
      },
      {
        type: "message",
        id: "inactive-tail",
        parentId: "inactive-parent",
        appendMode: "side",
        message: { role: "assistant", content: "inactive tail" },
      },
    ] as const;
    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      await waitForSessionTranscriptIndexReconcile(scope);
      replaceTranscriptSuffixForTest(scope, events, events.slice(0, -1), events.length - 1);

      expect(snapshot().raw).toHaveLength(events.length - 1);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
        ],
        search: [expect.objectContaining({ message_id: "user", text: "question" })],
      });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }, events);
  });

  it("reconciles when a later suffix event redirects above the retained anchor", async () => {
    const activeChild = {
      type: "message",
      id: "active-child",
      parentId: "answer",
      message: { role: "assistant", content: "active child" },
    } as const;
    const changedActiveChild = {
      ...activeChild,
      message: { role: "assistant", content: "changed active child" },
    } as const;
    const redirectedRoot = {
      type: "message",
      id: "redirected-root",
      parentId: null,
      message: { role: "assistant", content: "redirected root" },
    } as const;
    const removedTail = {
      type: "message",
      id: "removed-tail",
      parentId: "redirected-root",
      message: { role: "assistant", content: "removed tail" },
    } as const;
    const events = [...rewriteEvents, activeChild, redirectedRoot, removedTail] as const;
    const nextEvents = [...rewriteEvents, changedActiveChild, redirectedRoot] as const;

    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      await waitForSessionTranscriptIndexReconcile(scope);
      replaceTranscriptSuffixForTest(scope, events, nextEvents, rewriteEvents.length);

      expect(snapshot().raw).toHaveLength(nextEvents.length);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({
        active: [expect.objectContaining({ event_seq: nextEvents.length - 1 })],
        search: [
          expect.objectContaining({ message_id: "redirected-root", text: "redirected root" }),
        ],
      });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }, events);
  });

  it("reconciles when an inactive suffix starts below an active parent", async () => {
    const inactiveEvent = {
      type: "message",
      id: "inactive-child",
      parentId: "answer",
      appendMode: "side",
      message: { role: "assistant", content: "inactive child" },
    } as const;
    const activeEvent = {
      type: "message",
      id: "active-child",
      parentId: "answer",
      message: { role: "user", content: "active child" },
    } as const;
    const events = [...rewriteEvents, inactiveEvent, activeEvent] as const;
    const nextEvents = [...rewriteEvents, activeEvent] as const;

    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      await waitForSessionTranscriptIndexReconcile(scope);
      replaceTranscriptSuffixForTest(scope, events, nextEvents, rewriteEvents.length);

      expect(snapshot().raw).toHaveLength(nextEvents.length);
      await waitForSessionTranscriptIndexReconcile(scope);
      const result = snapshot();
      expect(result.active).toEqual([
        expect.objectContaining({ event_seq: 0 }),
        expect.objectContaining({ event_seq: 1 }),
        expect.objectContaining({ event_seq: 2 }),
        expect.objectContaining({ event_seq: 3 }),
      ]);
      expect(result.search).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message_id: "active-child", text: "active child" }),
        ]),
      );
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }, events);
  });

  it("reconciles when an active root-level suffix can expose older durable history", async () => {
    const activeRoot = {
      type: "message",
      id: "active-root",
      parentId: null,
      message: { role: "assistant", content: "active root" },
    } as const;
    const events = [...rewriteEvents, activeRoot] as const;

    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      await waitForSessionTranscriptIndexReconcile(scope);
      replaceTranscriptSuffixForTest(scope, events, rewriteEvents, rewriteEvents.length);

      expect(snapshot().raw).toHaveLength(rewriteEvents.length);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
          expect.objectContaining({ event_seq: 2 }),
        ],
        search: expect.arrayContaining([
          expect.objectContaining({ message_id: "user", text: "question" }),
          expect.objectContaining({ message_id: "answer", text: "answer" }),
        ]),
      });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }, events);
  });

  it("reconciles when an inactive suffix starts at a root-level side branch", async () => {
    const inactiveEvent = {
      type: "message",
      id: "inactive-root",
      parentId: null,
      appendMode: "side",
      message: { role: "assistant", content: "inactive root" },
    } as const;
    const activeEvent = {
      type: "message",
      id: "active-child",
      parentId: "user",
      message: { role: "assistant", content: "active child" },
    } as const;
    const events = [rewriteEvents[0], rewriteEvents[1], inactiveEvent, activeEvent] as const;
    const nextEvents = [rewriteEvents[0], rewriteEvents[1], activeEvent] as const;

    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      await waitForSessionTranscriptIndexReconcile(scope);
      replaceTranscriptSuffixForTest(scope, events, nextEvents, 2);

      expect(snapshot().raw).toHaveLength(nextEvents.length);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
          expect.objectContaining({ event_seq: 2 }),
        ],
        search: expect.arrayContaining([
          expect.objectContaining({ message_id: "user", text: "question" }),
          expect.objectContaining({ message_id: "active-child", text: "active child" }),
        ]),
      });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }, events);
  });

  it.each([
    {
      name: "row",
      events: [
        rewriteEvents[0],
        ...Array.from({ length: SYNC_REBUILD_MAX_ROWS + 1 }, (_value, index) => ({
          type: "message",
          id: `bounded-row-${index}`,
          parentId: index === 0 ? "root" : `bounded-row-${index - 1}`,
          message: { role: "user", content: `row ${index}` },
        })),
      ],
    },
    {
      name: "byte",
      events: [
        rewriteEvents[0],
        {
          type: "message",
          id: "bounded-byte-large",
          parentId: "root",
          message: { role: "user", content: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1) },
        },
        {
          type: "message",
          id: "bounded-byte-tail",
          parentId: "bounded-byte-large",
          message: { role: "assistant", content: "temporary" },
        },
      ],
    },
  ])("plans only the removable suffix above the $name limit", async ({ events }) => {
    await withRewriteFixture(({ db, scope }) => {
      const work = trackSqliteStatementExecutions(
        db,
        ["fullTranscript", "prefixScan", "sizeScan"],
        (sql) => {
          const normalized = sql.toLowerCase();
          if (normalized.includes("octet_length")) {
            return "sizeScan";
          }
          if (normalized.includes("transcript_events") && normalized.includes("offset")) {
            return "prefixScan";
          }
          if (
            normalized.includes("transcript_events") &&
            normalized.includes("event_json") &&
            !normalized.includes("limit")
          ) {
            return "fullTranscript";
          }
          return null;
        },
      );
      try {
        const plan = prepareSqliteTranscriptSuffixMutation(
          openOpenClawAgentDatabase(scope),
          scope,
          events,
          events.slice(0, -1),
          events.length - 1,
        );
        expect(plan.incremental).toBeDefined();
        expect(plan.expectedRows).toHaveLength(1);
        expect(plan.next).toHaveLength(0);
      } finally {
        work.restore();
      }
      expect(work.counts).toEqual({ fullTranscript: 0, prefixScan: 0, sizeScan: 0 });
    }, events);
  });

  it("replaces a retained suffix without routing rows through forward indexing", async () => {
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const retainedAnswer = {
        ...rewriteEvents[2],
        parentId: "root",
      };
      replaceTranscriptSuffixForTest(scope, rewriteEvents, [rewriteEvents[0], retainedAnswer]);

      expect(snapshot()).toMatchObject({
        raw: [expect.objectContaining({ seq: 0 }), expect.objectContaining({ seq: 1 })],
        identities: [expect.objectContaining({ seq: 0 }), expect.objectContaining({ seq: 1 })],
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
        ],
        search: [expect.objectContaining({ message_id: "answer", text: "answer" })],
      });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("validates only the unchanged projection prefix for same-length suffix replacement", async () => {
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const replacementEvents = [
        rewriteEvents[0],
        { ...rewriteEvents[1], message: { role: "user", content: "updated question" } },
        { ...rewriteEvents[2], message: { role: "assistant", content: "updated answer" } },
      ] as const;

      replaceTranscriptSuffixForTest(scope, rewriteEvents, replacementEvents);

      const result = snapshot();
      expect(result).toMatchObject({
        raw: [
          expect.objectContaining({ seq: 0 }),
          expect.objectContaining({ seq: 1 }),
          expect.objectContaining({ seq: 2 }),
        ],
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
          expect.objectContaining({ event_seq: 2 }),
        ],
      });
      expect(result.search).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message_id: "user", text: "updated question" }),
          expect.objectContaining({ message_id: "answer", text: "updated answer" }),
        ]),
      );
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("updates the idempotency owner when a retained event changes its key", async () => {
    const originalEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "owner",
        parentId: "root",
        message: { role: "assistant", content: "original", idempotencyKey: "old-key" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      const replacementEvents = [
        originalEvents[0],
        {
          ...originalEvents[1],
          message: { role: "assistant", content: "updated", idempotencyKey: "new-key" },
        },
      ] as const;

      replaceTranscriptSuffixForTest(scope, originalEvents, replacementEvents);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, "owner"),
      ).toEqual({ event_id: "owner", message_idempotency_key: "new-key" });
    }, originalEvents);
  });

  it("promotes an unchanged-prefix duplicate when a retained event changes its key", async () => {
    const originalEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "duplicate",
        parentId: "root",
        message: { role: "assistant", content: "duplicate", idempotencyKey: "old-key" },
      },
      {
        type: "message",
        id: "owner",
        parentId: "duplicate",
        message: { role: "assistant", content: "owner", idempotencyKey: "old-key" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "duplicate");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("old-key", scope.sessionId, "owner");
      const replacementEvents = [
        originalEvents[0],
        originalEvents[1],
        {
          ...originalEvents[2],
          message: { role: "assistant", content: "updated", idempotencyKey: "new-key" },
        },
      ] as const;

      replaceTranscriptSuffixForTest(scope, originalEvents, replacementEvents);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('duplicate', 'owner') ORDER BY event_id",
          )
          .all(scope.sessionId),
      ).toEqual([
        { event_id: "duplicate", message_idempotency_key: "old-key" },
        { event_id: "owner", message_idempotency_key: "new-key" },
      ]);
    }, originalEvents);
  });

  it("removes the idempotency owner when a retained event removes its key", async () => {
    const originalEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "owner",
        parentId: "root",
        message: { role: "assistant", content: "original", idempotencyKey: "old-key" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      const replacementEvents = [
        originalEvents[0],
        {
          ...originalEvents[1],
          message: { role: "assistant", content: "updated" },
        },
      ] as const;

      replaceTranscriptSuffixForTest(scope, originalEvents, replacementEvents);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, "owner"),
      ).toEqual({ event_id: "owner", message_idempotency_key: null });
    }, originalEvents);
  });

  it("preserves the established idempotency owner across retained suffix rows", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "first",
        parentId: "root",
        message: { role: "assistant", content: "first", idempotencyKey: "retry" },
      },
      { type: "custom", id: "removed", parentId: "first" },
      {
        type: "message",
        id: "owner",
        parentId: "removed",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_events SET created_at = CASE seq WHEN 1 THEN 101 WHEN 3 THEN 303 ELSE created_at END WHERE session_id = ?",
      ).run(scope.sessionId);
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL, created_at = 101 WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "first");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ?, created_at = 303 WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, "owner");

      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, [
        duplicateKeyEvents[0],
        duplicateKeyEvents[1],
        { ...duplicateKeyEvents[3], parentId: "first" },
      ]);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key, created_at FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('first', 'owner') ORDER BY event_id",
          )
          .all(scope.sessionId),
      ).toEqual([
        { event_id: "first", message_idempotency_key: null, created_at: 101 },
        { event_id: "owner", message_idempotency_key: "retry", created_at: 303 },
      ]);
      expect(
        db
          .prepare(
            "SELECT seq, created_at FROM transcript_events WHERE session_id = ? AND seq IN (1, 2) ORDER BY seq",
          )
          .all(scope.sessionId),
      ).toEqual([
        { seq: 1, created_at: 101 },
        { seq: 2, created_at: 303 },
      ]);
    }, duplicateKeyEvents);
  });

  it("reserves a retained idempotency owner when a new duplicate precedes it", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      { type: "custom", id: "removed", parentId: "root" },
      {
        type: "message",
        id: "owner",
        parentId: "removed",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, [
        duplicateKeyEvents[0],
        {
          type: "message",
          id: "new",
          parentId: "root",
          message: { role: "assistant", content: "new", idempotencyKey: "retry" },
        },
        { ...duplicateKeyEvents[2], parentId: "new" },
      ]);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('new', 'owner') ORDER BY event_id",
          )
          .all(scope.sessionId),
      ).toEqual([
        { event_id: "new", message_idempotency_key: null },
        { event_id: "owner", message_idempotency_key: "retry" },
      ]);
    }, duplicateKeyEvents);
  });

  it("promotes a retained duplicate when its prior idempotency owner is removed", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "owner",
        parentId: "root",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
      {
        type: "message",
        id: "duplicate",
        parentId: "owner",
        message: { role: "assistant", content: "duplicate", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, [
        duplicateKeyEvents[0],
        { ...duplicateKeyEvents[2], parentId: "root" },
      ]);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, "duplicate"),
      ).toEqual({ event_id: "duplicate", message_idempotency_key: "retry" });
    }, duplicateKeyEvents);
  });

  it("promotes an unchanged-prefix duplicate when its suffix owner is removed", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "duplicate",
        parentId: "root",
        message: { role: "assistant", content: "duplicate", idempotencyKey: "retry" },
      },
      {
        type: "message",
        id: "owner",
        parentId: "duplicate",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "duplicate");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, "owner");

      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, duplicateKeyEvents.slice(0, -1), 2);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, "duplicate"),
      ).toEqual({ event_id: "duplicate", message_idempotency_key: "retry" });
    }, duplicateKeyEvents);
  });

  it("skips malformed unchanged-prefix rows while promoting an idempotency owner", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      {
        type: "message",
        id: "corrupt-prefix",
        parentId: "root",
        message: { role: "assistant", content: "corrupt" },
      },
      {
        type: "message",
        id: "duplicate",
        parentId: "corrupt-prefix",
        message: { role: "assistant", content: "duplicate", idempotencyKey: "retry" },
      },
      {
        type: "message",
        id: "owner",
        parentId: "duplicate",
        message: { role: "assistant", content: "owner", idempotencyKey: "retry" },
      },
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "duplicate");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, "owner");
      db.prepare(
        `UPDATE transcript_events
         SET event_json = ?
         WHERE session_id = ?
           AND seq = (
             SELECT seq
             FROM transcript_event_identities
             WHERE session_id = ? AND event_id = ?
           )`,
      ).run("{", scope.sessionId, scope.sessionId, "corrupt-prefix");

      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, duplicateKeyEvents.slice(0, -1), 3);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, "duplicate"),
      ).toEqual({ event_id: "duplicate", message_idempotency_key: "retry" });
    }, duplicateKeyEvents);
  });

  it("promotes an idempotency owner beyond the projection rebuild row bound", async () => {
    const prefix = Array.from({ length: SYNC_REBUILD_MAX_ROWS + 1 }, (_value, index) => ({
      type: "message" as const,
      id: `keyed-prefix-${index}`,
      parentId: index === 0 ? "root" : `keyed-prefix-${index - 1}`,
      message: {
        role: "assistant" as const,
        content: `prefix ${index}`,
        ...(index === 0 ? { idempotencyKey: "\tretry\n" } : {}),
      },
    }));
    const owner = {
      type: "message" as const,
      id: "keyed-suffix-owner",
      parentId: prefix.at(-1)?.id ?? "root",
      message: { role: "assistant" as const, content: "owner", idempotencyKey: "retry" },
    };
    const duplicateKeyEvents = [rewriteEvents[0], ...prefix, owner];
    const duplicateId = prefix[0]!.id;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, duplicateId);
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, owner.id);
      replaceTranscriptSuffixForTest(
        scope,
        duplicateKeyEvents,
        duplicateKeyEvents.slice(0, -1),
        duplicateKeyEvents.length - 1,
      );
      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, duplicateId),
      ).toEqual({ event_id: duplicateId, message_idempotency_key: "retry" });
    }, duplicateKeyEvents);
  });

  it("removes a unique keyed suffix beyond the projection rebuild row bound", async () => {
    const prefix = Array.from({ length: SYNC_REBUILD_MAX_ROWS + 1 }, (_value, index) => ({
      type: "message" as const,
      id: `unique-prefix-${index}`,
      parentId: index === 0 ? "root" : `unique-prefix-${index - 1}`,
      message: { role: "assistant" as const, content: `prefix ${index}` },
    }));
    const owner = {
      type: "message" as const,
      id: "unique-suffix-owner",
      parentId: prefix.at(-1)?.id ?? "root",
      message: { role: "assistant" as const, content: "owner", idempotencyKey: "unique" },
    };
    const events = [rewriteEvents[0], ...prefix, owner];
    await withRewriteFixture(({ db, scope }) => {
      replaceTranscriptSuffixForTest(scope, events, events.slice(0, -1), events.length - 1);

      expect(
        db
          .prepare(
            "SELECT event_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, owner.id),
      ).toBeUndefined();
    }, events);
  });

  it("rotates generation while updating raw, identity, active, and FTS rows", async () => {
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const before = snapshot();
      replaceTranscriptSuffixForTest(scope, rewriteEvents, rewriteEvents.slice(0, 2));

      const after = snapshot();
      expect(after.generation).not.toBe(before.generation);
      expect(after.raw).toHaveLength(2);
      expect(after.identities).toHaveLength(2);
      expect(after.active).toHaveLength(2);
      expect(after.search).toMatchObject([{ message_id: "user", text: "question" }]);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("rotates generation when an already-dirty projection needs reconciliation", async () => {
    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      const before = snapshot();
      db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      ).run(scope.sessionId);

      replaceTranscriptSuffixForTest(scope, rewriteEvents, rewriteEvents.slice(0, 2));

      const rotatedGeneration = snapshot().generation;
      expect(rotatedGeneration).not.toBe(before.generation);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({
        generation: rotatedGeneration,
        raw: expect.arrayContaining([expect.objectContaining({ seq: 1 })]),
      });
      expect(snapshot().raw).toHaveLength(2);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("preserves retained row timestamps when an already-dirty projection needs reconciliation", async () => {
    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      db.prepare(
        "UPDATE transcript_events SET created_at = 303 WHERE session_id = ? AND seq = 2",
      ).run(scope.sessionId);
      db.prepare(
        "UPDATE transcript_event_identities SET created_at = 303 WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "answer");
      db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      ).run(scope.sessionId);
      const retainedAnswer = { ...rewriteEvents[2], parentId: "root" };

      replaceTranscriptSuffixForTest(scope, rewriteEvents, [rewriteEvents[0], retainedAnswer], 1);

      expect(snapshot().raw).toEqual([
        expect.objectContaining({ seq: 0 }),
        expect.objectContaining({ created_at: 303, seq: 1 }),
      ]);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot().identities).toEqual([
        expect.objectContaining({ seq: 0 }),
        expect.objectContaining({ created_at: 303, event_id: "answer", seq: 1 }),
      ]);
    });
  });
});
