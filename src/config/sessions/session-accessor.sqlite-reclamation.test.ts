import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { loadTranscriptEvents } from "./session-accessor.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
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
