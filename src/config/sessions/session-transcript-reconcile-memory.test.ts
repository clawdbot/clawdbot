import fs from "node:fs";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabaseByPath,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import {
  appendTranscriptEvent,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.js";
import { prepareSessionTranscriptProjection } from "./session-transcript-projection-rebuild.js";
import { createMemoryTranscriptProjectionSource } from "./session-transcript-reconcile-memory.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

const agentId = "secondary";
const sessionId = "memory-reconcile";
const sessionKey = "agent:secondary:dashboard:incognito-reconcile";
const message = (id: string, content = id): TranscriptEvent => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "user", content },
});

describe("incognito transcript reconciliation", () => {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;

  beforeEach(async () => {
    ambient = await createOpenClawTestState({ prefix: "memory-reconcile-ambient-" });
    explicit = await createOpenClawTestState({
      prefix: "memory-reconcile-explicit-",
      applyEnv: false,
    });
  });

  afterEach(async () => {
    for (const state of [explicit, ambient]) {
      await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
      closeOpenClawAgentDatabaseByPath(
        resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env }),
      );
      await state.cleanup();
    }
  });

  function target(env: NodeJS.ProcessEnv | undefined) {
    const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
    return {
      options: { agentId, env, path },
      scope: { agentId, env, sessionId, sessionKey, storePath: path },
    };
  }

  function expectNoDiskState() {
    expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
  }

  it.each(["ambient", "explicit"] as const)(
    "repairs a supported branch through the scheduled worker (%s environment)",
    async (environment) => {
      const { scope, options } = target(environment === "ambient" ? undefined : explicit.env);
      const turn = await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "root", parentId: null, message: { role: "user", content: "root" } },
          {
            eventId: "abandoned",
            parentId: "root",
            message: { role: "assistant", content: "🦞".repeat(262_144) },
          },
          {
            eventId: "active",
            parentId: "root",
            message: { role: "assistant", content: "active" },
          },
        ],
        touchSessionEntry: false,
      });
      expect.soft(turn.messages[0]?.anchor?.storePath).toBe(options.path);
      const rowCount = (env: NodeJS.ProcessEnv | undefined) => {
        const selected = target(env).options;
        return getOpenClawAgentDatabaseIfOpen(selected)
          ?.db.prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
          .get(sessionId);
      };
      expect.soft(rowCount(options.env)).toEqual({ count: 4 });
      if (environment === "explicit") {
        expect.soft(rowCount(ambient.env)).toBeUndefined();
      }
      await waitForSessionTranscriptIndexReconcile(options);
      const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });
      expect(page.events.map(({ event }) => event)).toEqual([
        expect.objectContaining({ id: "root", message: { role: "user", content: "root" } }),
        expect.objectContaining({
          id: "active",
          message: { role: "assistant", content: "active" },
        }),
      ]);
      const database = getOpenClawAgentDatabaseIfOpen(options)!;
      expect(
        database.db
          .prepare(
            "SELECT message_id, text FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id",
          )
          .all(sessionId),
      ).toEqual([
        { message_id: "active", text: "active" },
        { message_id: "root", text: "root" },
      ]);
      expectNoDiskState();
    },
    30_000,
  );

  it("transfers exact UTF-8 in bounded frames without retaining a transaction", async () => {
    const { scope, options } = target(explicit.env);
    const event = message("large", "🦞".repeat(131_073));
    await replaceTranscriptEvents(scope, [event]);
    const database = openOpenClawAgentDatabase(options);
    const source = createMemoryTranscriptProjectionSource(database, options);
    const bytes: Uint8Array[] = [];
    while (true) {
      const frame = source.read(sessionId);
      expect(database.db.isTransaction).toBe(false);
      if (frame.type === "source-end") {
        break;
      }
      expect(frame.type).toBe("source-frame");
      if (frame.type !== "source-frame") {
        throw new Error("source unexpectedly unavailable");
      }
      expect(frame.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
      bytes.push(frame.bytes);
    }
    expect(bytes.length).toBeGreaterThan(1);
    expect(JSON.parse(Buffer.concat(bytes).toString("utf8"))).toEqual(event);
    expectNoDiskState();
  });

  it("keeps scoped cursors and entry touching when the entry arrives during preparation", async () => {
    const { scope, options } = target(explicit.env);
    const entry = { incognito: true as const, sessionId, updatedAt: 1 };
    const result = await persistSessionTranscriptTurn(
      { ...scope, sessionEntry: entry },
      {
        messages: [
          {
            eventId: "scoped-message",
            message: { role: "user", content: "scoped content" },
            shouldAppend: async (context) => {
              expect(Object.keys(context).toSorted()).toEqual([
                "agentId",
                "sessionId",
                "sessionKey",
                "storePath",
              ]);
              await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }));
              return true;
            },
          },
        ],
        touchSessionEntry: true,
      },
    );
    expect(result.messages[0]?.anchor?.storePath).toBe(options.path);
    expect(readCommittedTranscriptMessageSequence(result.messages[0]!)).toBe(1);
    expect(loadSessionEntry(scope)?.updatedAt).toBeGreaterThan(1);
    expect(getOpenClawAgentDatabaseIfOpen(target(ambient.env).options)).toBeUndefined();
    expectNoDiskState();
  });

  it.each(["append", "replace", "delete-recreate", "dispose", "reopen"] as const)(
    "revokes a captured source after %s before another frame or plan is accepted",
    async (mutation) => {
      const { scope, options } = target(explicit.env);
      await replaceTranscriptEvents(scope, [message("original", "x".repeat(300_000))]);
      const database = openOpenClawAgentDatabase(options);
      const source = createMemoryTranscriptProjectionSource(database, options);
      const plan = prepareSessionTranscriptProjection(database.db, sessionId)!;
      expect(source.read(sessionId)).toMatchObject({ type: "source-frame", final: false });
      expect(source.isCurrentPlan(plan)).toBe(true);
      if (mutation === "dispose" || mutation === "reopen") {
        closeOpenClawAgentDatabaseByPath(database.path);
        if (mutation === "reopen") {
          await replaceTranscriptEvents(scope, [message("replacement")]);
        }
        expect(() => source.read(sessionId)).toThrow("disposed");
        expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(database);
        if (mutation === "dispose") {
          expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
        }
      } else {
        if (mutation === "append") {
          await appendTranscriptEvent(scope, { type: "metadata", id: "appended" });
        } else {
          if (mutation === "delete-recreate") {
            await replaceTranscriptEvents(scope, []);
          }
          await replaceTranscriptEvents(scope, [message("replacement")]);
        }
        expect(source.isCurrentPlan(plan)).toBe(false);
        expect(source.read(sessionId)).toEqual({ type: "source-unavailable" });
      }
      source.clear();
      expectNoDiskState();
    },
  );

  it.each(["direct", "scheduled"] as const)(
    "does not reopen an owner disposed before queued %s preflight",
    async (mode) => {
      const { scope, options } = target(explicit.env);
      await replaceTranscriptEvents(scope, [message("seed")]);
      const database = openOpenClawAgentDatabase(options);
      const blocked = createDeferred();
      const release = createDeferred();
      const blocker = runExclusiveSqliteSessionWrite(options, async () => {
        blocked.resolve();
        await release.promise;
      });
      await blocked.promise;
      let pending: Promise<unknown>;
      if (mode === "direct") {
        pending = reconcileSessionTranscriptIndexes(options);
      } else {
        startSessionTranscriptIndexReconcile(options);
        pending = waitForSessionTranscriptIndexReconcile(options);
      }
      const outcome = pending.then(
        () => "fulfilled",
        () => "rejected",
      );
      try {
        closeOpenClawAgentDatabaseByPath(database.path);
        if (mode === "scheduled") {
          await waitForSessionTranscriptProjection(scope);
        }
      } finally {
        release.resolve();
        await blocker;
      }
      const result = await outcome;
      expect(database.db.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(result).toBe(mode === "direct" ? "rejected" : "fulfilled");
      expectNoDiskState();
    },
  );

  it.each(["plan-start", "active-chunk", "fts-chunk", "plan-finish", "pending"] as const)(
    "joins a queued %s before finishing disposal without reopening state",
    async (stage) => {
      const { scope, options } = target(explicit.env);
      await replaceTranscriptEvents(scope, [message("seed")]);
      const database = openOpenClawAgentDatabase(options);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
      const blocked = createDeferred();
      const release = createDeferred();
      let blocker: Promise<void> | undefined;
      let worker: Worker | undefined;
      const params = {
        ...options,
        createWorker: (filename: string | URL, workerOptions: WorkerOptions) => {
          worker = new Worker(filename, workerOptions);
          worker.on("message", (workerMessage: { type: string }) => {
            if (workerMessage.type === (stage === "pending" ? "active-chunk" : stage) && !blocker) {
              if (stage === "pending") {
                startSessionTranscriptIndexReconcile(params);
              }
              // Enter the real FIFO ahead of the owner handler, then dispose
              // immediately before its queued write could acquire a database.
              blocker = runExclusiveSqliteSessionWrite(options, async () => {
                blocked.resolve();
                await release.promise;
                closeOpenClawAgentDatabaseByPath(database.path);
              });
            }
          });
          return worker;
        },
      };
      let pending: Promise<unknown>;
      if (stage === "pending") {
        startSessionTranscriptIndexReconcile(params);
        pending = waitForSessionTranscriptIndexReconcile(options);
      } else {
        pending = reconcileSessionTranscriptIndexes(params);
      }
      const outcome = pending.then(
        () => "fulfilled",
        () => "rejected",
      );
      try {
        await withTestTimeout(blocked.promise, 10_000, "memory worker did not reach writer fence");
      } finally {
        release.resolve();
        await blocker;
        await outcome;
      }
      expect(await outcome).toBe(stage === "pending" ? "fulfilled" : "rejected");
      expect(worker?.threadId).toBe(-1);
      expect(database.db.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expectNoDiskState();
    },
    20_000,
  );

  it("joins the final memory sweep after the worker exits naturally", async () => {
    const { scope, options } = target(explicit.env);
    await replaceTranscriptEvents(scope, [message("seed")]);
    const database = openOpenClawAgentDatabase(options);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const blocked = createDeferred();
    const release = createDeferred();
    const exited = createDeferred<number>();
    let blocker: Promise<void> | undefined;
    let worker: Worker | undefined;
    let settled = false;
    const outcome = reconcileSessionTranscriptIndexes({
      ...options,
      createWorker: (filename, workerOptions) => {
        worker = new Worker(filename, workerOptions);
        worker.once("exit", exited.resolve);
        worker.on("message", (workerMessage: { type: string }) => {
          if (workerMessage.type === "done") {
            // Memory's port can close while its final parent write waits in the FIFO.
            blocker = runExclusiveSqliteSessionWrite(options, async () => {
              blocked.resolve();
              await release.promise;
            });
          }
        });
        return worker;
      },
    }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await withTestTimeout(blocked.promise, 10_000, "memory final sweep did not reach its fence");
      expect(
        await withTestTimeout(exited.promise, 10_000, "memory worker did not exit naturally"),
      ).toBe(0);
      expect(worker?.threadId).toBe(-1);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await blocker;
      await outcome;
    }
    expect(await outcome).toEqual({ value: { reconciledSessions: 1 } });
    expectNoDiskState();
  }, 20_000);

  it("hands a successor's scheduled work over after successful old-owner settlement", async () => {
    const { scope, options } = target(ambient.env);
    await replaceTranscriptEvents(scope, [message("old-owner")]);
    const database = openOpenClawAgentDatabase(options);
    const state = () =>
      getOpenClawAgentDatabaseIfOpen(options)
        ?.db.prepare(
          "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(sessionId);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const joined = createDeferred();
    const release = createDeferred();
    const workers: Worker[] = [];
    startSessionTranscriptIndexReconcile({
      ...options,
      createWorker: (filename, workerOptions) => {
        const worker = new Worker(filename, workerOptions);
        workers.push(worker);
        if (workers.length === 1) {
          const terminate = worker.terminate.bind(worker);
          worker.terminate = async () => {
            const code = await terminate();
            joined.resolve();
            await release.promise;
            return code;
          };
        }
        return worker;
      },
    });
    const pending = waitForSessionTranscriptIndexReconcile(options);
    try {
      await withTestTimeout(joined.promise, 10_000, "old memory worker did not settle");
      expect(state()).toEqual({ needs_rebuild: 0 });
      expect(workers[0]?.threadId).toBe(-1);
      closeOpenClawAgentDatabaseByPath(database.path);
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "root", parentId: null, message: { role: "user", content: "root" } },
          {
            eventId: "abandoned",
            parentId: "root",
            message: { role: "assistant", content: "abandoned" },
          },
          {
            eventId: "active",
            parentId: "root",
            message: { role: "assistant", content: "active" },
          },
        ],
        touchSessionEntry: false,
      });
      expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(database);
      expect(state()).toEqual({ needs_rebuild: 1 });
    } finally {
      release.resolve();
      await pending;
    }
    expect(state()).toEqual({ needs_rebuild: 0 });
    expect(
      readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
        ({ event }) => event,
      ),
    ).toEqual([expect.objectContaining({ id: "root" }), expect.objectContaining({ id: "active" })]);
    expect(workers.map((worker) => worker.threadId)).toEqual([-1, -1]);
    expectNoDiskState();
  }, 20_000);
});
