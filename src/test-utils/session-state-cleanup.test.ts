// Tests session-state cleanup helpers used by integration fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  cleanupSessionStateForTest,
  resetSessionStateCleanupRuntimeForTests,
  setSessionStateCleanupRuntimeForTests,
} from "./session-state-cleanup.js";

const drainFileLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const drainSessionStoreWriterQueuesMock = vi.hoisted(() => vi.fn(async () => undefined));

async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

describe("cleanupSessionStateForTest", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    drainFileLockStateMock.mockClear();
    drainSessionStoreWriterQueuesMock.mockClear();
    setSessionStateCleanupRuntimeForTests({
      drainFileLockStateForTest: drainFileLockStateMock,
      drainSessionStoreWriterQueuesForTest: drainSessionStoreWriterQueuesMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    resetSessionStateCleanupRuntimeForTests();
    vi.restoreAllMocks();
  });

  it("waits for in-flight session store writer queues before clearing test state", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cleanup-"));
    const storePath = path.join(fixtureRoot, "openclaw-sessions.json");
    const started = createDeferred();
    const release = createDeferred();
    const drainRequested = createDeferred();
    let finishDrain: () => void = () => undefined;
    drainSessionStoreWriterQueuesMock.mockImplementationOnce(async () => {
      drainRequested.resolve();
      await new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
    });
    let running: Promise<void> | undefined;
    try {
      running = runExclusiveSessionStoreWrite(storePath, async () => {
        started.resolve();
        await release.promise;
      });

      await started.promise;

      let settled = false;
      const cleanupPromise = cleanupSessionStateForTest().then(() => {
        settled = true;
      });

      await drainRequested.promise;
      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(drainSessionStoreWriterQueuesMock).toHaveBeenCalledTimes(1);
      expect(drainFileLockStateMock).not.toHaveBeenCalled();

      release.resolve();
      await running;
      finishDrain();
      await cleanupPromise;

      expect(drainFileLockStateMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      finishDrain();
      await running?.catch(() => undefined);
      await cleanupSessionStateForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("waits for SQLite session writers before closing their database handles", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-session-cleanup-sqlite-"),
    );
    const databasePath = path.join(fixtureRoot, "openclaw-agent.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot };
    const started = createDeferred();
    const release = createDeferred();
    let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    setSessionStateCleanupRuntimeForTests({ drainSessionStoreWriterQueuesForTest: null });

    const running = runExclusiveSqliteSessionWrite(
      { agentId: "main", env, path: databasePath },
      async () => {
        started.resolve();
        await release.promise;
        database = openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
      },
    );
    try {
      await started.promise;
      let cleanupSettled = false;
      cleanupPromise = cleanupSessionStateForTest({ stateDir: fixtureRoot }).then(() => {
        cleanupSettled = true;
      });

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(cleanupSettled).toBe(false);

      release.resolve();
      await running;
      await cleanupPromise;
      expect(database?.db.isOpen).toBe(false);
    } finally {
      release.resolve();
      await running;
      if (cleanupPromise) {
        await cleanupPromise;
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
