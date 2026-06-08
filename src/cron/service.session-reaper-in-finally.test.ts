// Session reaper finally tests cover cleanup after cron service failures.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionStoreForTest,
  writeSessionStoreForTestAsync,
} from "../config/sessions/test-helpers.js";
import {
  createNoopLogger,
  createCronStoreHarness,
  withCronServiceStateForTest,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";
import { resetReaperThrottle } from "./session-reaper.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-reaper-finally-",
});

function createDueIsolatedJob(params: { id: string; nowMs: number }): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: params.nowMs },
  };
}

describe("CronService - session reaper runs in finally block (#31946)", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    resetReaperThrottle();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("session reaper runs even when job execution throws", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDueIsolatedJob({ id: "failing-job", nowMs: now })],
    });

    // Create a mock sessionStorePath to track if the reaper is called.
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      // This will throw, simulating a failure during job execution.
      runIsolatedAgentJob: vi.fn().mockRejectedValue(new Error("gateway down")),
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);

      // After onTimer finishes (even with a job error), state.running must be
      // false — proving the finally block executed.
      expect(state.running).toBe(false);

      // The timer must be re-armed.
      if (state.timer === null) {
        throw new Error("expected timer to be re-armed");
      }
    });
  });

  it("session reaper runs when resolveSessionStorePath is provided", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");

    await saveCronStore(store.storePath, {
      version: 1,
      jobs: [createDueIsolatedJob({ id: "ok-job", nowMs: now })],
    });

    const resolvedPaths: string[] = [];
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "done" }),
      resolveSessionStorePath: (agentId) => {
        const p = path.join(path.dirname(store.storePath), `${agentId}-sessions`, "sessions.json");
        resolvedPaths.push(p);
        return p;
      },
    });

    await withCronServiceStateForTest(state, async () => {
      await onTimer(state);

      // The resolveSessionStorePath callback should have been invoked to build
      // the set of store paths for the session reaper.
      expect(resolvedPaths.length).toBeGreaterThan(0);
      expect(state.running).toBe(false);
    });
  });

  it("prunes expired cron-run sessions while ignoring malformed legacy cron files", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T10:00:00.000Z");
    const sessionStorePath = path.join(path.dirname(store.storePath), "sessions", "sessions.json");

    // Runtime reads SQLite only; malformed legacy JSON is migrated by doctor,
    // not imported or thrown from the timer path.
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, "{invalid-json", "utf-8");

    // Seed an expired cron-run session entry that should be pruned by the reaper.
    await writeSessionStoreForTestAsync(sessionStorePath, {
      "agent:agent-default:cron:failing-job:run:stale": {
        sessionId: "session-stale",
        updatedAt: now - 3 * 24 * 3_600_000,
      },
    });

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      sessionStorePath,
    });

    await withCronServiceStateForTest(state, async () => {
      await expect(onTimer(state)).resolves.toBeUndefined();

      const updatedSessionStore = readSessionStoreForTest(sessionStorePath);
      expect(updatedSessionStore).toStrictEqual({});
      expect(state.running).toBe(false);
    });
  });
});
