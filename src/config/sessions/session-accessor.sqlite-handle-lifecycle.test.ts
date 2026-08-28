import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  withTranscriptWriteLock,
} from "./session-accessor.js";
import { readSessionTranscriptMessageEventPage } from "./session-accessor.sqlite-active-events.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  afterMaterialize: undefined as (() => void) | undefined,
}));

// Close the cached handle after the real archive worker yields back to its caller.
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      const result = await actual.materializeSessionStateDeletePlans(...args);
      archiveMaterializationHook.afterMaterialize?.();
      return result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite session handle lifecycle", () => {
  let scope: { sessionId: string; sessionKey: string; storePath: string };
  let databasePath: string;

  beforeEach(async () => {
    scope = {
      sessionId: "handle-session",
      sessionKey: "agent:main:handle-session",
      storePath: path.join(tempDirs.make("openclaw-session-handle-"), "sessions.json"),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    databasePath = resolveSqliteTargetFromSessionStorePath(scope.storePath).path!;
  });

  afterEach(() => {
    archiveMaterializationHook.afterMaterialize = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([0, 1])(
    "releases a transcript read after JSON parsing fails at row %i",
    async (index) => {
      const events = [
        { type: "message", id: "first", message: { role: "user", content: "first" } },
        { type: "message", id: "second", message: { role: "assistant", content: "second" } },
        { type: "message", id: "third", message: { role: "user", content: "third" } },
      ];
      await replaceTranscriptEvents(scope, events);
      const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
      const row = database.db
        .prepare(
          "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1 OFFSET ?",
        )
        .get(scope.sessionId, index) as { seq: number; event_json: string };
      const update = database.db.prepare(
        "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?",
      );
      update.run("{malformed", scope.sessionId, row.seq);

      expect(() => loadTranscriptEventsSync(scope)).toThrow(SyntaxError);
      expect(database.db.isTransaction).toBe(false);
      // A leaked iterator can retain a read lock even after the transaction rolls back.
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });

      update.run(row.event_json, scope.sessionId, row.seq);
      expect(loadTranscriptEventsSync(scope)).toEqual(events);
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: "after failure" },
      });
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        ...events,
        expect.objectContaining({ message: expect.objectContaining({ content: "after failure" }) }),
      ]);
    },
  );

  it.each(["events", "message facts"])(
    "reads %s after a locked callback loses its handle",
    async (kind) => {
      const message = { role: "user", content: "retained", idempotencyKey: "handle-message" };
      await appendTranscriptMessage(scope, { message });

      await withTranscriptWriteLock(scope, async (transcript) => {
        const before = await transcript.readEvents();
        expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
        if (kind === "events") {
          await expect(transcript.readEvents()).resolves.toEqual(before);
        } else {
          const facts = await transcript.readMessageFacts({
            idempotencyKeys: [message.idempotencyKey],
          });
          expect(facts.messagesByIdempotencyKey.get(message.idempotencyKey)).toMatchObject(message);
        }
      });
    },
  );

  it("commits a turn after its async predicate loses the cached handle", async () => {
    const result = await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          message: { role: "user", content: "append after close" },
          shouldAppend: async () => {
            expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
            return true;
          },
        },
      ],
      updateMode: "none",
    });

    expect(result.appendedCount).toBe(1);
    await expect(loadTranscriptEvents(scope)).resolves.toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ content: "append after close" }),
      }),
    );
  });

  it("commits a lifecycle projection after its async builder loses the cached handle", async () => {
    await expect(
      applySessionEntryLifecycleMutation({
        storePath: scope.storePath,
        skipMaintenance: true,
        upserts: [
          {
            sessionKey: scope.sessionKey,
            buildEntry: async ({ currentEntry }) => {
              expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
              return { ...currentEntry!, label: "built after close" };
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ afterCount: 1 });
    expect(loadSessionEntry(scope)).toMatchObject({ label: "built after close" });
  });

  it("waits for projection repair after its polling handle closes", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "target", message: { role: "user", content: "target" } }],
      touchSessionEntry: false,
    });
    const databaseOptions = { agentId: "main", path: databasePath };
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    startSessionTranscriptIndexReconcile(databaseOptions);
    try {
      const ready = waitForSessionTranscriptProjection(scope);
      expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
      await ready;
      expect(
        readSessionTranscriptMessageEventPage(scope, { maxMessages: 0, offset: 0 }).totalMessages,
      ).toBe(1);
    } finally {
      await waitForSessionTranscriptIndexReconcile(databaseOptions);
    }
  });

  it("cancels a projection wait while its worker is stalled", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "target", message: { role: "user", content: "target" } }],
      touchSessionEntry: false,
    });
    const databaseOptions = { agentId: "main", path: databasePath };
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
    let stalledWorker: Worker | undefined;
    startSessionTranscriptIndexReconcile({
      ...databaseOptions,
      createWorker: () => {
        stalledWorker = new Worker("setInterval(() => {}, 1_000)", { eval: true });
        return stalledWorker;
      },
    });
    const controller = new AbortController();
    const abortReason = new Error("cancel stalled projection wait");

    try {
      const ready = waitForSessionTranscriptProjection(scope, controller.signal);
      await vi.waitFor(() => expect(stalledWorker).toBeDefined());
      controller.abort(abortReason);
      const outcome = await Promise.race([
        ready.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "still-waiting" }>((resolve) => {
          setTimeout(() => resolve({ kind: "still-waiting" }), 250);
        }),
      ]);
      expect(outcome).toMatchObject({
        kind: "rejected",
        error: { name: "AbortError", cause: abortReason },
      });
    } finally {
      await stalledWorker?.terminate();
      await waitForSessionTranscriptIndexReconcile(databaseOptions);
    }
  });

  it("completes a disk-budget sweep after its handle closes during archive materialization", async () => {
    const { sessionKey, sessionId, storePath } = scope;
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "retained history" },
    ]);
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "current-session", updatedAt: 2 },
    );
    const closeHandle = vi.fn(() => {
      expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
    });
    archiveMaterializationHook.afterMaterialize = closeHandle;

    await expect(
      enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: 1, highWaterBytes: 0 },
      }),
    ).resolves.toMatchObject({ removedEntries: 1, removedFiles: 1 });

    expect(closeHandle).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("current-session");
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
  });
});
