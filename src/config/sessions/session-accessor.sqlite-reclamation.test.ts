import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop, setTimeout as delay } from "node:timers/promises";
import { isMainThread, threadId } from "node:worker_threads";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { flushLogger, setLoggerOverride } from "../../logging/logger.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { loadTranscriptEvents } from "./session-accessor.js";
import { runSqliteTranscriptArchiveWorkerOperation } from "./session-accessor.sqlite-archive.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import {
  createHistoryEvictionReclamationPlan,
  runSqliteSessionReclamation,
  type SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";

const hooks = vi.hoisted(() => ({ beforeAuthorization: undefined as (() => void) | undefined }));
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    runSqliteTranscriptArchiveWorkerOperation: (
      params: Parameters<typeof actual.runSqliteTranscriptArchiveWorkerOperation>[0],
    ) =>
      actual.runSqliteTranscriptArchiveWorkerOperation({
        ...params,
        onCommitRequest: () => {
          hooks.beforeAuthorization?.();
          params.onCommitRequest?.();
        },
      }),
  };
});
afterEach(() => {
  hooks.beforeAuthorization = undefined;
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-reclamation-writers-") };
  const options = { agentId: "main", env };
  const scopes = ["parent", "child"].map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  const databaseOptions = { ...options, path: database.path };
  const plan = createHistoryEvictionReclamationPlan({
    databaseOptions,
    diskBudget: {},
    materializedPlans: [],
    protectedSessionIds: new Set(scopes.map((scope) => scope.sessionId)),
    sessionId: "already-removed-history",
  });
  return { database, databaseOptions, plan, scopes };
}

test.each([
  { operation: "append", rejected: false },
  { operation: "append", rejected: true },
  { operation: "replace", rejected: false },
  { operation: "replace", rejected: true },
  { operation: "entry", rejected: false },
  { operation: "entry", rejected: true },
  { operation: "board", rejected: false },
  { operation: "board", rejected: true },
])(
  "two synchronous writers progress at reclamation ($operation, rejected: $rejected)",
  async ({ operation, rejected }) => {
    const { databaseOptions, plan, scopes } = createFixture();
    const workers: Array<{ worker: Worker; id: number }> = [];
    const observeWorker = (worker: Worker) => workers.push({ worker, id: worker.threadId });
    process.on("worker", observeWorker);
    const diagnostics: SqliteSessionReclamationDiagnostics = {};
    const board = new SqliteBoardStore({
      env: databaseOptions.env,
      resolveSession: ({ sessionKey }) => ({ ...databaseOptions, sessionKey }),
    });
    const appends: unknown[] = [];
    const appendErrors: unknown[] = [];
    let commitChecks = 0;
    const owner = new AsyncLocalStorage<string>();
    hooks.beforeAuthorization = () =>
      owner.run("transcript-writer", () => {
        // The worker owns BEGIN IMMEDIATE and is waiting for the parent. Both sync
        // runtimes must service that request before its queued handler can return.
        for (const scope of scopes) {
          try {
            if (operation === "entry") {
              replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 2 });
              appends.push(loadSessionEntry(scope)?.updatedAt);
              continue;
            }
            if (operation === "board") {
              // First use enters the board's schema transaction before its canonical writer.
              appends.push(
                board.putWidget({
                  sessionKey: scope.sessionKey,
                  name: "writer-proof",
                  content: { kind: "html", html: "<p>committed</p>" },
                }).revision,
              );
              continue;
            }
            const event = { type: "session", id: scope.sessionId };
            appends.push(
              operation === "replace"
                ? replaceTranscriptEventsSync(scope, [event])
                : appendTranscriptEventSync(scope, event),
            );
          } catch (error) {
            appendErrors.push(error);
          }
        }
      });
    const reclamation = owner.run("reclamation-owner", () =>
      runExclusiveSqliteSessionWrite(
        databaseOptions,
        () =>
          runSqliteSessionReclamation({
            diagnostics,
            forceInProcess: false,
            plan,
            assertCommitAllowed: () => {
              commitChecks += 1;
              expect(owner.getStore()).toBe("reclamation-owner");
              if (rejected) {
                throw new Error("reclamation owner retired");
              }
            },
          }),
        diagnostics,
      ),
    );
    try {
      if (rejected) {
        await expect(reclamation).rejects.toThrow("reclamation owner retired");
      } else {
        await expect(reclamation).resolves.toEqual({
          kind: "history-eviction",
          value: { archivedTranscripts: [], deleted: true },
        });
      }
    } finally {
      process.off("worker", observeWorker);
    }
    expect(workers).toHaveLength(1);
    expect(workers[0]?.id).toBeGreaterThan(0);
    expect(diagnostics).toEqual({ kind: "history-eviction", workerThreadId: workers[0]?.id });
    expect(workers[0]?.worker.threadId).toBe(-1);
    expect(commitChecks).toBe(1);
    expect(appendErrors).toEqual([]);
    expect(appends).toEqual(
      operation === "entry"
        ? [2, 2]
        : operation === "board"
          ? [1, 1]
          : operation === "replace"
            ? [true, true]
            : [
                { ok: true, value: true },
                { ok: true, value: true },
              ],
    );
    for (const scope of scopes) {
      if (operation === "entry") {
        expect(loadSessionEntry(scope)).toMatchObject({ sessionId: scope.sessionId, updatedAt: 2 });
        continue;
      }
      if (operation === "board") {
        expect(board.getSnapshot({ sessionKey: scope.sessionKey }).widgets).toMatchObject([
          { name: "writer-proof", revision: 1 },
        ]);
        continue;
      }
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([
        { type: "session", id: scope.sessionId },
      ]);
    }
  },
  20_000,
);

test("one reclamation pass leaves a large freelist for bounded later maintenance", async () => {
  const { database, plan, scopes } = createFixture();
  // sqlite-allow-raw -- synthetic disposable pages exercise the real vacuum boundary.
  database.db.exec(`CREATE TABLE reclamation_fixture (payload BLOB);
    INSERT INTO reclamation_fixture VALUES (zeroblob(8388608));
    DROP TABLE reclamation_fixture;`);
  const freePages = () =>
    Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  const before = freePages();
  expect(before).toBeGreaterThan(512);

  await expect(runSqliteSessionReclamation({ forceInProcess: false, plan })).resolves.toMatchObject(
    { value: { deleted: true } },
  );

  const after = freePages();
  expect(before - after).toBeGreaterThan(0);
  expect(before - after).toBeLessThanOrEqual(512);
  expect(after).toBeGreaterThan(0);
  for (const scope of scopes) {
    expect(appendTranscriptEventSync(scope, { type: "session", id: scope.sessionId })).toEqual({
      ok: true,
      value: true,
    });
  }
  const budgetBefore = freePages();
  const databaseOptions = plan.databaseOptions;
  const duringDrain = yieldToEventLoop().then(() => {
    expect(budgetBefore - freePages()).toBeGreaterThan(0);
    expect(budgetBefore - freePages()).toBeLessThanOrEqual(512);
    expect(database.db.isTransaction).toBe(false);
    closeOpenClawAgentDatabaseByPath(database.path);
    for (const scope of scopes) {
      expect(appendTranscriptEventSync(scope, { type: "budget-progress" })).toEqual({
        ok: true,
        value: true,
      });
    }
  });
  await Promise.all([reclaimSqliteFreePages(databaseOptions), duringDrain]);
  const reopened = openOpenClawAgentDatabase(databaseOptions);
  expect(Number(reopened.db.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBe(0);
});

test("queued and different-store reclamations retain only their own worker identity", async () => {
  const first = createFixture();
  const other = createFixture();
  const diagnostics: SqliteSessionReclamationDiagnostics[] = [{}, {}, {}];
  const operations = [first, first, other].map((fixture, index) => {
    const record = diagnostics[index];
    return runExclusiveSqliteSessionWrite(
      fixture.databaseOptions,
      () =>
        runSqliteSessionReclamation({
          forceInProcess: false,
          plan: fixture.plan,
          diagnostics: record,
        }),
      record,
    );
  });
  try {
    // The same-store successor has not entered its callback or claimed a worker.
    expect(diagnostics[1]).toEqual({});
    await Promise.all(operations);
    expect(diagnostics.map((record) => record.kind)).toEqual([
      "history-eviction",
      "history-eviction",
      "history-eviction",
    ]);
    const ids = diagnostics.map((record) => record.workerThreadId);
    expect(ids.every((id) => typeof id === "number" && id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  } finally {
    await Promise.allSettled(operations);
  }
});

test("in-process reclamation and rejected worker construction do not invent a worker identity", async () => {
  const { plan } = createFixture();
  const inProcess: SqliteSessionReclamationDiagnostics = {};
  await runSqliteSessionReclamation({ forceInProcess: true, plan, diagnostics: inProcess });
  expect(inProcess).toEqual({ kind: "history-eviction" });

  const rejected: SqliteSessionReclamationDiagnostics = {};
  await expect(
    runSqliteTranscriptArchiveWorkerOperation({
      diagnostics: rejected,
      expectedMessageType: "reclaimed",
      workerData: { notCloneable: () => undefined },
    }),
  ).rejects.toMatchObject({ name: "DataCloneError" });
  expect(rejected).toEqual({});
});

test("file warnings link an awaited native worker without attributing it to the queued successor", async () => {
  const { databaseOptions, plan } = createFixture();
  const file = path.join(tempDirs.make("openclaw-writer-log-"), "writer.log");
  const diagnostics: SqliteSessionReclamationDiagnostics = {};
  const workers: Array<{ worker: Worker; id: number }> = [];
  const observeWorker = (worker: Worker) => workers.push({ worker, id: worker.threadId });
  setLoggerOverride({ level: "info", file });
  process.on("worker", observeWorker);
  const first = runExclusiveSqliteSessionWrite(
    databaseOptions,
    async () => {
      // Exercise the real slow-warning threshold without a large database or a fake clock.
      await delay(1_100);
      return runSqliteSessionReclamation({ forceInProcess: false, plan, diagnostics });
    },
    diagnostics,
  );
  const second = runExclusiveSqliteSessionWrite(databaseOptions, async () => "successor");
  try {
    await expect(first).resolves.toMatchObject({ kind: "history-eviction" });
    await expect(second).resolves.toBe("successor");
    await flushLogger();
    const records = (await fs.readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record["1"] === "slow SQLite session write")
      .map((record) => record["2"]);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.id).toBeGreaterThan(0);
    expect(workers[0]?.worker.threadId).toBe(-1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      pid: process.pid,
      threadId,
      isMainThread,
      reclamationKind: "history-eviction",
      workerThreadId: workers[0]?.id,
    });
    expect(records[1]).toMatchObject({ pid: process.pid, threadId, isMainThread });
    expect(records[1]).not.toHaveProperty("workerThreadId");
    expect(records[1]).not.toHaveProperty("reclamationKind");
  } finally {
    await Promise.allSettled([first, second]);
    process.off("worker", observeWorker);
    await flushLogger();
    setLoggerOverride(null);
  }
});
