import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createQueueTestRun as createRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  persistFollowupQueues,
  restoreFollowupQueues,
  setRestoredFollowupQueuesListener,
} from "../auto-reply/reply/queue/persist.js";
import { FOLLOWUP_QUEUES } from "../auto-reply/reply/queue/state.js";
import type { QueueSettings } from "../auto-reply/reply/queue/types.js";

const { enqueueSystemEvent, requestHeartbeat } = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  requestHeartbeat: vi.fn(),
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeat,
}));

const { wakeRestoredFollowupQueueSessions, scheduleRestoredFollowupQueueRecovery } =
  await import("./server-followup-queue-recovery.js");

describe("wakeRestoredFollowupQueueSessions", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

  beforeEach(() => {
    enqueueSystemEvent.mockClear();
    requestHeartbeat.mockClear();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    setRestoredFollowupQueuesListener(undefined);
    vi.useRealTimers();
  });

  it("returns zero when no restored followup queues are pending", () => {
    expect(wakeRestoredFollowupQueueSessions()).toBe(0);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("wakes each session that has a non-empty restored followup queue", () => {
    const tmpDir = tempDirs.make("openclaw-followup-recovery-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:recovery-${Date.now()}`;

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "after restart" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(wakeRestoredFollowupQueueSessions()).toBe(1);
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("Restored 1 pending followup message"),
        { sessionKey: key },
      );
      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "followup-queue-restore",
        intent: "immediate",
        reason: "restored-followup-queue",
        sessionKey: key,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("still wakes restored queues when a second runtime copy sees the restore-once flag", () => {
    const tmpDir = tempDirs.make("openclaw-followup-split-runtime-recovery-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:split-${Date.now()}`;

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "after restart" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();
      restoreFollowupQueues();

      expect(wakeRestoredFollowupQueueSessions()).toBe(1);
      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "followup-queue-restore",
        intent: "immediate",
        reason: "restored-followup-queue",
        sessionKey: key,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("wakes summary-only restored queues using retained routing facts", () => {
    const tmpDir = tempDirs.make("openclaw-followup-summary-recovery-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:summary-${Date.now()}`;

    try {
      const queueKey = key;
      FOLLOWUP_QUEUES.set(queueKey, {
        abortController: new AbortController(),
        items: [],
        draining: false,
        inFlight: new Set(),
        lastEnqueuedAt: Date.now(),
        mode: "followup",
        debounceMs: 0,
        cap: 50,
        dropPolicy: "summarize",
        droppedCount: 1,
        summaryLines: ["summarized overflow"],
        summarySources: [
          createRun({
            prompt: "summarized overflow",
            originatingChannel: "telegram",
            originatingTo: "6300969793",
          }),
        ],
        steerAcceptanceTail: Promise.resolve(true),
        activeSummarySources: new WeakSet(),
        summaryElisions: [],
        evictedSummaryCount: 0,
        lastRun: createRun({ prompt: "anchor" }).run,
      });
      // Ensure routing sessionKey matches wake target.
      const queue = FOLLOWUP_QUEUES.get(queueKey)!;
      queue.summarySources[0]!.run.sessionKey = queueKey;
      queue.lastRun!.sessionKey = queueKey;
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(queueKey);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(wakeRestoredFollowupQueueSessions()).toBe(1);
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining("Restored 1 pending followup message"),
        { sessionKey: queueKey },
      );
      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "followup-queue-restore",
        intent: "immediate",
        reason: "restored-followup-queue",
        sessionKey: queueKey,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});

describe("scheduleRestoredFollowupQueueRecovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

  beforeEach(() => {
    enqueueSystemEvent.mockClear();
    requestHeartbeat.mockClear();
  });

  afterEach(() => {
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    setRestoredFollowupQueuesListener(undefined);
    vi.useRealTimers();
  });

  it("wakes restored queues when restore succeeds after the startup timer", () => {
    vi.useFakeTimers();
    const tmpDir = tempDirs.make("openclaw-followup-recovery-retry-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:retry-wake-${Date.now()}`;
    const log = { error: vi.fn() };

    try {
      scheduleRestoredFollowupQueueRecovery({ log, delayMs: 1_250 });
      vi.advanceTimersByTime(1_250);
      expect(requestHeartbeat).not.toHaveBeenCalled();

      enqueueFollowupRun(
        key,
        createRun({ prompt: "after delayed restore" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "followup-queue-restore",
        intent: "immediate",
        reason: "restored-followup-queue",
        sessionKey: key,
      });
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("does not wake after dispose before the startup timer", () => {
    vi.useFakeTimers();
    const tmpDir = tempDirs.make("openclaw-followup-recovery-stop-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:stop-before-timeout-${Date.now()}`;
    const log = { error: vi.fn() };

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "should not wake after stop" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      const dispose = scheduleRestoredFollowupQueueRecovery({ log, delayMs: 1_250 });
      dispose();
      vi.advanceTimersByTime(1_250);
      expect(requestHeartbeat).not.toHaveBeenCalled();

      restoreFollowupQueues();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("unregisters only the matching restore listener", () => {
    vi.useFakeTimers();
    const tmpDir = tempDirs.make("openclaw-followup-recovery-listener-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const key = `agent:main:telegram:direct:listener-replace-${Date.now()}`;
    const log = { error: vi.fn() };

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "later lifecycle owns the listener" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      persistFollowupQueues();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      const disposeFirst = scheduleRestoredFollowupQueueRecovery({ log, delayMs: 1_250 });
      const disposeSecond = scheduleRestoredFollowupQueueRecovery({ log, delayMs: 1_250 });
      disposeFirst();
      vi.advanceTimersByTime(1_250);
      expect(requestHeartbeat).toHaveBeenCalledTimes(1);
      expect(requestHeartbeat).toHaveBeenCalledWith({
        source: "followup-queue-restore",
        intent: "immediate",
        reason: "restored-followup-queue",
        sessionKey: key,
      });
      disposeSecond();
    } finally {
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
