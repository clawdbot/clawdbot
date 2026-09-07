import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { createAgentDeletionDatabaseCleanup } from "../../state/agent-deletion-cleanup.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import { loadTranscriptEvents, replaceSessionEntry } from "./session-accessor.js";
import {
  materializeSessionStateDeletePlans,
  runExclusiveSqliteTranscriptArchiveWorker,
} from "./session-accessor.sqlite-archive.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker.js";
import {
  createHistoryEvictionReclamationPlan,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.js";
import { reclaimSqliteFreePages } from "./session-history-archive-pruning.js";
import { enforceSqliteSessionHistoryDiskBudget } from "./session-history-eviction.js";

const hooks = vi.hoisted(() => ({
  beforeAuthorization: undefined as (() => void) | undefined,
  workerSource: undefined as string | undefined,
}));
vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    createSqliteTranscriptArchiveWorker: (
      ...args: Parameters<typeof actual.createSqliteTranscriptArchiveWorker>
    ) => {
      const worker = hooks.workerSource
        ? new Worker(hooks.workerSource, { eval: true })
        : actual.createSqliteTranscriptArchiveWorker(...args);
      worker.prependListener("message", (message: { type: string }) => {
        if (message.type === "commit-request") {
          hooks.beforeAuthorization?.();
        }
      });
      return worker;
    },
  };
});
afterEach(() => {
  hooks.beforeAuthorization = undefined;
  hooks.workerSource = undefined;
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
      runExclusiveSqliteSessionWrite(databaseOptions, () =>
        runSqliteSessionReclamation({
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
      ),
    );
    if (rejected) {
      await expect(reclamation).rejects.toThrow("reclamation owner retired");
    } else {
      await expect(reclamation).resolves.toEqual({
        kind: "history-eviction",
        value: { archivedTranscripts: [], deleted: true },
      });
    }
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

function observeWorkers() {
  const workers: Worker[] = [];
  const exits: number[] = [];
  const workerChannel = channel("worker_threads");
  const observe = (message: unknown) => {
    const { worker } = message as { worker: Worker };
    workers.push(worker);
    worker.once("exit", (code) => exits.push(code));
  };
  workerChannel.subscribe(observe);
  return { workers, exits, [Symbol.dispose]: () => workerChannel.unsubscribe(observe) };
}

async function createVictimFixture() {
  const fixture = createFixture();
  const scope = fixture.scopes[0]!;
  const event = { type: "session", id: scope.sessionId, content: "preserve on rejection" };
  replaceTranscriptEventsSync(scope, [event]);
  replaceSessionEntrySync(scope, { sessionId: "successor", updatedAt: 2 });
  const deletePlan = planSessionStateDeleteIfUnreferenced({
    archiveDirectory: fixture.databaseOptions.env.OPENCLAW_STATE_DIR,
    archiveTranscript: false,
    database: fixture.database,
    referencedSessionIds: new Set(),
    sessionId: scope.sessionId,
  });
  if (!deletePlan) {
    throw new Error("expected historical victim");
  }
  const plan = createHistoryEvictionReclamationPlan({
    databaseOptions: fixture.databaseOptions,
    diskBudget: {},
    materializedPlans: await materializeSessionStateDeletePlans([deletePlan]),
    protectedSessionIds: new Set(),
    sessionId: scope.sessionId,
  });
  const leases = () =>
    openOpenClawStateDatabase({ env: fixture.databaseOptions.env })
      .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
      .all(fixture.database.path);
  return { ...fixture, plan, scope, event, leases };
}

test.each([false, true])(
  "reuses a verified Worker but captures each request's authority (reject: %s)",
  async (rejected) => {
    const fixture = await createVictimFixture();
    using observed = observeWorkers();
    const worker = new SqliteReclamationWorker();
    const context = new AsyncLocalStorage<string>();
    const checked: string[] = [];
    const initialLeases = fixture.leases();
    let warmLeases: unknown;
    try {
      // Warm the same physical reclaimer without consuming the victim.
      await context.run("first-owner", () =>
        runSqliteSessionReclamation({
          forceInProcess: false,
          plan: { ...fixture.plan, materializedPlans: [], sessionId: "already-gone" },
          worker,
          assertCommitAllowed: () => {
            checked.push(context.getStore()!);
            expect(context.getStore()).toBe("first-owner");
          },
        }),
      );
      warmLeases = fixture.leases();
      expect(warmLeases).toHaveLength(initialLeases.length + 1);
      expect(observed.exits).toEqual([]);
      const attempt = context.run("second-owner", () =>
        runSqliteSessionReclamation({
          forceInProcess: false,
          plan: fixture.plan,
          worker,
          assertCommitAllowed: () => {
            checked.push(context.getStore()!);
            expect(context.getStore()).toBe("second-owner");
            if (rejected) {
              throw new Error("second owner retired");
            }
          },
        }),
      );
      if (rejected) {
        await expect(attempt).rejects.toThrow("second owner retired");
        expect(observed.workers[0]?.threadId).toBe(-1);
        await worker.close();
      } else {
        await expect(attempt).resolves.toMatchObject({ value: { deleted: true } });
        expect(fixture.leases()).toEqual(warmLeases);
        await worker.close();
      }
      expect(checked).toEqual(["first-owner", "second-owner"]);
      expect(observed.workers).toHaveLength(1);
      expect(observed.exits).toHaveLength(1);
      expect(fixture.leases()).toEqual(initialLeases);
      await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual(
        rejected ? [fixture.event] : [],
      );
    } finally {
      await worker.close().catch(() => {});
    }
  },
);

test.each(["queued", "commit"] as const)(
  "closing a %s sweep rejects work and joins rollback",
  async (phase) => {
    const fixture = await createVictimFixture();
    using observed = observeWorkers();
    const worker = new SqliteReclamationWorker();
    let closing: Promise<void> | undefined;
    let release = () => {};
    const blocked =
      phase === "queued"
        ? runExclusiveSqliteTranscriptArchiveWorker(
            () =>
              new Promise<void>((resolve) => {
                release = resolve;
              }),
          )
        : undefined;
    if (blocked) {
      await yieldToEventLoop();
    } else {
      hooks.beforeAuthorization = () => {
        closing = worker.close();
        void closing.catch(() => {});
      };
    }
    const attempt = runSqliteSessionReclamation({
      forceInProcess: false,
      plan: fixture.plan,
      worker,
    });
    const rejected = expect(attempt).rejects.toThrow("scope is closed");
    if (blocked) {
      closing = worker.close();
      await closing; // A never-started scope must not wait for another owner's Worker.
      release();
      await blocked;
    }
    await rejected;
    await closing?.catch(() => {});
    expect(observed.workers).toHaveLength(phase === "queued" ? 0 : 1);
    expect(observed.exits).toHaveLength(observed.workers.length);
    await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual([fixture.event]);
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plan, worker }),
    ).rejects.toThrow("scope is closed");
  },
);

test.each(["path", "environment", "closed", "replaced", "closed at commit"] as const)(
  "does not reuse a sweep after its database is %s",
  async (change) => {
    const fixture = await createVictimFixture();
    using observed = observeWorkers();
    await using worker = new SqliteReclamationWorker();
    await runSqliteSessionReclamation({
      forceInProcess: false,
      plan: { ...fixture.plan, materializedPlans: [], sessionId: "gone" },
      worker,
    });
    const options = structuredClone(fixture.plan.databaseOptions);
    if (change === "path") {
      options.path += ".different";
    } else if (change === "environment") {
      options.env.OPENCLAW_STATE_DIR += "/different";
    } else if (change === "closed at commit") {
      hooks.beforeAuthorization = () => fixture.database.db.close();
    } else {
      closeOpenClawAgentDatabaseByPath(options.path);
      if (change === "replaced") {
        openOpenClawAgentDatabase(options);
      }
    }
    await expect(
      runSqliteSessionReclamation({
        forceInProcess: false,
        plan: { ...fixture.plan, databaseOptions: options },
        worker,
      }),
    ).rejects.toThrow("database owner is no longer current");
    await worker.close();
    expect(observed.workers).toHaveLength(1);
    expect(observed.exits).toEqual([change === "closed at commit" ? 1 : 0]);
    await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual([fixture.event]);
  },
);

test("interleaved stores retain independent Worker connections and request contexts", async () => {
  const fixtures = [await createVictimFixture(), await createVictimFixture()];
  using observed = observeWorkers();
  await using first = new SqliteReclamationWorker();
  await using second = new SqliteReclamationWorker();
  const workers = [first, second];
  const context = new AsyncLocalStorage<string>();
  for (const index of [0, 1, 0, 1]) {
    const fixture = fixtures[index]!;
    await context.run(`store-${index}`, () =>
      runSqliteSessionReclamation({
        forceInProcess: false,
        worker: workers[index],
        plan: { ...fixture.plan, materializedPlans: [], sessionId: "gone" },
        assertCommitAllowed: () => expect(context.getStore()).toBe(`store-${index}`),
      }),
    );
    expect(fixture.leases()).toHaveLength(2);
  }
  await first.close();
  expect(fixtures[0]!.leases()).toHaveLength(1);
  expect(fixtures[1]!.leases()).toHaveLength(2);
  await second.close();
  expect(observed.workers).toHaveLength(2);
  expect(observed.exits).toEqual([0, 0]);
});

test("revalidates the requesting database-cleanup scope, not the first request's scope", async () => {
  const fixture = await createVictimFixture();
  closeOpenClawAgentDatabaseByPath(fixture.database.path);
  const state = openOpenClawStateDatabase({ env: fixture.databaseOptions.env });
  const cleanup = createAgentDeletionDatabaseCleanup({
    statePath: state.path,
    assertAdmission: () => {},
    assertCurrent: () => {},
    assertJournal: () => "test",
  });
  const outside = AsyncLocalStorage.snapshot();
  await using worker = new SqliteReclamationWorker();
  let retained: (() => Promise<unknown>) | undefined;
  await cleanup({ agentId: "main", path: fixture.database.path }, async () => {
    const run = () =>
      runSqliteSessionReclamation({
        forceInProcess: false,
        plan: { ...fixture.plan, materializedPlans: [], sessionId: "gone" },
        worker,
      });
    const inside = AsyncLocalStorage.snapshot();
    retained = () => inside(run);
    await run();
    await expect(outside(run)).rejects.toThrow("active deletion cleanup");
    await worker.close();
  });
  await expect(retained!()).rejects.toThrow("scope is closed");
});

test("stale responses cannot settle a successor and duplicate commit requests cannot replay its guard", async () => {
  const fixture = await createVictimFixture();
  using observed = observeWorkers();
  await using worker = new SqliteReclamationWorker();
  await runSqliteSessionReclamation({
    forceInProcess: false,
    worker,
    plan: { ...fixture.plan, materializedPlans: [], sessionId: "gone" },
  });
  const guard = vi.fn();
  hooks.beforeAuthorization = () => {
    hooks.beforeAuthorization = undefined;
    const concrete = observed.workers[0]!;
    // Inject transport replays on the real Worker's EventEmitter; SQLite still owns the result.
    concrete.emit("message", { type: "reclaimed", operationId: 1, result: { stale: true } });
    concrete.emit("message", { type: "commit-request", operationId: 1 });
    concrete.emit("message", { type: "commit-request", operationId: 2 });
  };
  await expect(
    runSqliteSessionReclamation({
      forceInProcess: false,
      worker,
      plan: fixture.plan,
      assertCommitAllowed: guard,
    }),
  ).resolves.toMatchObject({ value: { deleted: true } });
  expect(guard).toHaveBeenCalledOnce();
  await worker.close();
  expect(observed.exits).toEqual([0]);
  await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual([]);
});

test.each(["error", "exit", "result-then-exit"] as const)(
  "standalone reclamation joins a concrete Worker after %s",
  async (outcome) => {
    const fixture = await createVictimFixture();
    using observed = observeWorkers();
    // A concrete Node endpoint faults the transport, independently of the SQLite owner tests above.
    hooks.workerSource = `
    const { parentPort } = require('node:worker_threads');
    parentPort.once('message', (request) => {
      if (${JSON.stringify(outcome)} === 'result-then-exit') {
        parentPort.postMessage({type: 'reclaimed', operationId: request.operationId,
          result: {kind: 'history-eviction', value: {deleted: true, archivedTranscripts: []}}});
      }
      if (${JSON.stringify(outcome)} === 'error') throw new Error('injected Worker failure');
      process.exit(7);
    });
  `;
    await expect(
      runSqliteSessionReclamation({ forceInProcess: false, plan: fixture.plan }),
    ).rejects.toThrow(outcome === "error" ? "injected Worker failure" : "exited with code 7");
    expect(observed.workers).toHaveLength(1);
    expect(observed.exits).toHaveLength(1);
    expect(observed.workers[0]?.threadId).toBe(-1);
    await expect(loadTranscriptEvents(fixture.scope)).resolves.toEqual([fixture.event]);
  },
);

test.each([false, true])(
  "owns one joined reclamation Worker across history and cap-archive victims (failure: %s)",
  async (failure) =>
    withOpenClawTestState(
      { prefix: "openclaw-session-history-budget-", layout: "state-only" },
      async (state) => {
        const sessionKey = "agent:main:sweep-lifetime";
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const databaseOptions = { agentId: "main", env: state.env };
        for (const [index, sessionId] of ["first", "second", "current"].entries()) {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              sessionId,
              updatedAt: index + 1,
              ...(sessionId === "current"
                ? { archivedAt: 4, archiveReason: "active-session-cap" as const }
                : {}),
            },
          );
        }
        await reclaimSqliteFreePages(databaseOptions);
        using observed = observeWorkers();
        const reclamation = await import("./session-accessor.sqlite-reclamation.js");
        const run = reclamation.runSqliteSessionReclamation;
        let requests = 0;
        const dispatch = vi
          .spyOn(reclamation, "runSqliteSessionReclamation")
          .mockImplementation(async (params) => {
            if (++requests === 2 && failure) {
              throw new Error("next victim preparation failed");
            }
            return await run(params);
          });
        try {
          const sweep = enforceSqliteSessionHistoryDiskBudget({
            storePath,
            mode: "enforce",
            maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
          });
          if (failure) {
            await expect(sweep).rejects.toThrow("next victim preparation failed");
          } else {
            const result = await sweep;
            expect(result?.removedEntries).toBe(3);
            expect(result?.totalBytesAfter).toBe(
              (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
            );
          }
          const database = openOpenClawAgentDatabase(databaseOptions);
          const surviving = database.db
            .prepare("SELECT session_id FROM session_windows ORDER BY session_id")
            .all();
          expect(surviving).toEqual(
            failure ? [{ session_id: "current" }, { session_id: "second" }] : [],
          );
          expect(observed.workers).toHaveLength(1);
          expect(observed.exits).toEqual([0]);
          expect(observed.workers[0]?.threadId).toBe(-1);
        } finally {
          dispatch.mockRestore();
        }
      },
    ),
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
