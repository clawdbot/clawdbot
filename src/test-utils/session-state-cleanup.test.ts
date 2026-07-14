// Tests session-state cleanup helpers used by integration fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import { createDeferred } from "./deferred.js";
import {
  cleanupSessionStateForTest,
  resetSessionStateCleanupRuntimeForTests,
  setSessionStateCleanupRuntimeForTests,
} from "./session-state-cleanup.js";

const drainFileLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const drainSessionStoreWriterQueuesMock = vi.hoisted(() => vi.fn(async () => undefined));
const drainSessionWriteLockStateMock = vi.hoisted(() => vi.fn(async () => undefined));

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
    resetSessionWriteLockStateForTest();
    drainFileLockStateMock.mockClear();
    drainSessionStoreWriterQueuesMock.mockClear();
    drainSessionWriteLockStateMock.mockClear();
    setSessionStateCleanupRuntimeForTests({
      drainFileLockStateForTest: drainFileLockStateMock,
      drainSessionStoreWriterQueuesForTest: drainSessionStoreWriterQueuesMock,
      drainSessionWriteLockStateForTest: drainSessionWriteLockStateMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
    resetSessionWriteLockStateForTest();
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
      expect(drainSessionWriteLockStateMock).not.toHaveBeenCalled();

      release.resolve();
      await running;
      finishDrain();
      await cleanupPromise;

      expect(drainFileLockStateMock).toHaveBeenCalledTimes(1);
      expect(drainSessionWriteLockStateMock).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      finishDrain();
      await running?.catch(() => undefined);
      await cleanupSessionStateForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
