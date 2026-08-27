// Tests restored follow-up drain and cancel-ack restart behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as followupQueueSqlite from "../../infra/followup-queue-sqlite.js";
import {
  followupQueueEntryContainsPrompt,
  hasFollowupQueueEntries,
} from "../../infra/followup-queue-sqlite.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { kickFollowupDrainIfIdle, rememberFollowupDrainCallback } from "./queue/drain.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  peekRestoredPendingDrainKeys,
  persistFollowupQueues,
  restoreFollowupQueues,
} from "./queue/persist.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

describe("followup queue drain restart persistence", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("drains restored queue items when a followup callback is registered after restart", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-restore-drain-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-restored-drain-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const drained = createDeferred();

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "survived restart" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      rememberFollowupDrainCallback(key, async (run) => {
        expect(run.prompt).toBe("survived restart");
        drained.resolve();
      });
      // Drain restored items only via the idle-aware path. Registering the
      // callback alone (the previous trigger point) would have raced with any
      // active turn for this route; the sweep now lives in kickFollowupDrainIfIdle,
      // which enqueue only calls when restartIfIdle && !queue.draining holds.
      kickFollowupDrainIfIdle(key);

      await drained.promise;
    } finally {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("drains restored items via production enqueue idle-kick after restart", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-prod-kick-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-restored-prod-kick-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const drainCalls: FollowupRun[] = [];

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "survived restart" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      const runFollowup = async (run: FollowupRun) => {
        drainCalls.push(run);
      };
      // Mirrors agent-runner after the active turn finishes: enqueue registers
      // the callback and restartIfIdle=true kicks the restored queue.
      enqueueFollowupRun(
        key,
        createRun({ prompt: "next inbound turn" }),
        settings,
        "message-id",
        runFollowup,
        true,
      );

      for (let i = 0; i < 10 && drainCalls.length === 0; i++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(drainCalls.length).toBeGreaterThanOrEqual(1);
      expect(drainCalls[0]?.prompt).toBe("survived restart");
    } finally {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("does not drain restored items just because a callback is registered (active-turn race)", async () => {
    // Models the race the bot's [P1] flagged: when enqueueFollowupRun is called
    // mid-turn with restartIfIdle=false, it still calls rememberFollowupDrainCallback.
    // That registration must not, on its own, schedule a drain for a restored
    // queue, or the restored items would be dispatched concurrently with the
    // active turn they should wait behind.
    const tmpDir = tempDirs.make("openclaw-queue-race-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-restored-race-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const drainCalls: FollowupRun[] = [];

    try {
      enqueueFollowupRun(
        key,
        createRun({ prompt: "survived restart" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      // Plain registration — simulates an enqueue mid-turn with restartIfIdle=false.
      rememberFollowupDrainCallback(key, async (run) => {
        drainCalls.push(run);
      });

      // Yield a few microtasks; nothing should have drained because the
      // idle-aware kick was never invoked.
      for (let i = 0; i < 5; i++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(drainCalls).toHaveLength(0);

      // Now the active turn would have finished and enqueue's idle-kick fires.
      kickFollowupDrainIfIdle(key);
      // Spin a few microtasks to let the scheduled drain complete.
      for (let i = 0; i < 10 && drainCalls.length === 0; i++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(drainCalls).toHaveLength(1);
      expect(drainCalls[0]?.prompt).toBe("survived restart");
    } finally {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("does not drain another route's restored items when one route goes idle (per-key isolation)", async () => {
    // Race the previous P1 was trying to fix had a subtler relative: even with
    // the sweep moved to kickFollowupDrainIfIdle, a global sweep would drain
    // route B's restored items when route A's idle-kick fires, because the
    // caller only confirmed idle for A. Locks per-key isolation: A's idle-kick
    // does NOT touch B's pending-restore entry or B's callback.
    const tmpDir = tempDirs.make("openclaw-queue-isolation-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const keyA = `test-restored-iso-A-${Date.now()}`;
    const keyB = `test-restored-iso-B-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const drainsA: FollowupRun[] = [];
    const drainsB: FollowupRun[] = [];

    try {
      // Seed two restored queues on disk, one per route.
      enqueueFollowupRun(
        keyA,
        createRun({ prompt: "restored A" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      enqueueFollowupRun(
        keyB,
        createRun({ prompt: "restored B" }),
        settings,
        "message-id",
        undefined,
        false,
      );
      FOLLOWUP_QUEUES.delete(keyA);
      FOLLOWUP_QUEUES.delete(keyB);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      // Register callbacks for BOTH routes. Route B's callback would normally
      // be registered during B's active turn (restartIfIdle=false).
      rememberFollowupDrainCallback(keyA, async (run) => {
        drainsA.push(run);
      });
      rememberFollowupDrainCallback(keyB, async (run) => {
        drainsB.push(run);
      });

      // Only route A goes idle and kicks. Per-key isolation: B must not drain.
      kickFollowupDrainIfIdle(keyA);
      for (let i = 0; i < 10 && drainsA.length === 0; i++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(drainsA).toHaveLength(1);
      expect(drainsA[0]?.prompt).toBe("restored A");
      expect(drainsB).toHaveLength(0);

      // Now B's own idle-kick fires; B drains.
      kickFollowupDrainIfIdle(keyB);
      for (let i = 0; i < 10 && drainsB.length === 0; i++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(drainsB).toHaveLength(1);
      expect(drainsB[0]?.prompt).toBe("restored B");
    } finally {
      FOLLOWUP_QUEUES.delete(keyA);
      FOLLOWUP_QUEUES.delete(keyB);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("persists the queue after dropAbortedFollowups removes an aborted item", async () => {
    // Bot P2 (drain.ts:336-344): the abort-drop path splices items out of the
    // queue without immediately persisting. A gateway crash between the splice
    // and the next persist would leave the aborted item on disk — and because
    // abortSignal is not serialized, restore would replay an item the source
    // already canceled.
    const tmpDir = tempDirs.make("openclaw-queue-abort-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-abort-drop-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const drainCalls: FollowupRun[] = [];
    const drained = createDeferred();

    try {
      // Enqueue first with a non-aborted signal — enqueueFollowupRun rejects
      // already-aborted runs upfront. Then abort the signal so dropAbortedFollowups
      // catches it on the next drain iteration.
      const aborter = new AbortController();
      enqueueFollowupRun(
        key,
        { ...createRun({ prompt: "aborted item" }), abortSignal: aborter.signal },
        settings,
      );

      // Shared SQLite should contain the queued item right now.
      expect(hasFollowupQueueEntries()).toBe(true);
      expect(followupQueueEntryContainsPrompt(key, "aborted item")).toBe(true);

      // Abort after enqueue so dropAbortedFollowups will splice it out.
      aborter.abort();

      const runFollowup = async (run: FollowupRun) => {
        drainCalls.push(run);
        drained.resolve();
      };
      scheduleFollowupDrain(key, runFollowup);
      await drained.promise;
      // Spin a few microtasks so the drain loop's finally + cleanup run.
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }

      // After the drain, the queue is empty and shared SQLite should not
      // contain the aborted item anymore.
      expect(followupQueueEntryContainsPrompt(key, "aborted item")).toBe(false);
      // Confirm the abort path actually ran (the callback was invoked with
      // the aborted run before splice).
      expect(drainCalls.some((r) => r.prompt === "aborted item")).toBe(true);
    } finally {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("restores canceled entries when acknowledgement fails and does not execute them after restart", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-abort-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-abort-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const abortedPrompt = "canceled-ack-fail";
    const drainCalls: FollowupRun[] = [];
    const abortedSeen = createDeferred();
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let retainedEntries: Array<[string, unknown]> | undefined;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const hasAborted = params.entries.some(
          ([entryKey, data]) => entryKey === key && JSON.stringify(data).includes(abortedPrompt),
        );
        if (!hasAborted && retainedEntries === undefined) {
          retainedEntries = followupQueueSqlite.loadFollowupQueueEntries();
          throw new Error("injected sqlite acknowledgement failure");
        }
        originalReplace(params);
      });

    try {
      const aborter = new AbortController();
      enqueueFollowupRun(
        key,
        {
          ...createRun({
            prompt: abortedPrompt,
            originatingChannel: "telegram",
            originatingTo: "12345",
          }),
          abortSignal: aborter.signal,
        },
        settings,
      );
      expect(followupQueueEntryContainsPrompt(key, abortedPrompt)).toBe(true);
      aborter.abort();

      scheduleFollowupDrain(key, async (run) => {
        drainCalls.push(run);
        if (run.prompt === abortedPrompt) {
          abortedSeen.resolve();
        }
      });
      await abortedSeen.promise;
      await vi.waitFor(() => {
        expect(retainedEntries).toBeDefined();
      });

      const retained = retainedEntries?.find(([entryKey]) => entryKey === key)?.[1] as {
        items?: Array<{ prompt?: string; canceled?: true }>;
      };
      expect(
        retained?.items?.some((item) => item.prompt === abortedPrompt && item.canceled === true),
      ).toBe(true);
      expect(FOLLOWUP_QUEUES.get(key)?.items.some((item) => item.prompt === abortedPrompt)).toBe(
        true,
      );

      replaceSpy.mockRestore();
      originalReplace({ entries: retainedEntries ?? [] });
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(peekRestoredPendingDrainKeys().has(key)).toBe(false);
      expect(drainCalls.some((run) => run.prompt === abortedPrompt && run.canceled !== true)).toBe(
        false,
      );
    } finally {
      replaceSpy.mockRestore();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("does not execute a collect-drain cancellation after an acknowledgement failure restart", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-collect-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-collect-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "collect", debounceMs: 0, cap: 50 };
    const firstPrompt = "collect-canceled-first";
    const secondPrompt = "collect-canceled-second";
    const drainCalls: FollowupRun[] = [];
    const collectStarted = createDeferred();
    const releaseCollect = createDeferred();
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let retainedEntries: Array<[string, unknown]> | undefined;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const hasCanceled = params.entries.some(
          ([entryKey, data]) =>
            entryKey === key &&
            (JSON.stringify(data).includes(firstPrompt) ||
              JSON.stringify(data).includes(secondPrompt)),
        );
        if (!hasCanceled && retainedEntries === undefined) {
          retainedEntries = followupQueueSqlite.loadFollowupQueueEntries();
          throw new Error("injected sqlite acknowledgement failure");
        }
        originalReplace(params);
      });

    try {
      const firstAbort = new AbortController();
      const secondAbort = new AbortController();
      enqueueFollowupRun(
        key,
        {
          ...createRun({
            prompt: firstPrompt,
            originatingChannel: "telegram",
            originatingTo: "12345",
          }),
          abortSignal: firstAbort.signal,
        },
        settings,
      );
      enqueueFollowupRun(
        key,
        {
          ...createRun({
            prompt: secondPrompt,
            originatingChannel: "telegram",
            originatingTo: "12345",
          }),
          abortSignal: secondAbort.signal,
        },
        settings,
      );

      scheduleFollowupDrain(key, async (run) => {
        drainCalls.push(run);
        if (run.prompt.includes(firstPrompt) || run.prompt.includes(secondPrompt)) {
          collectStarted.resolve();
          await releaseCollect.promise;
        }
      });
      await collectStarted.promise;
      firstAbort.abort();
      secondAbort.abort();
      releaseCollect.resolve();
      await vi.waitFor(() => {
        expect(retainedEntries).toBeDefined();
      });

      const retained = retainedEntries?.find(([entryKey]) => entryKey === key)?.[1] as {
        items?: Array<{ prompt?: string; canceled?: true }>;
      };
      expect(
        retained?.items?.some((item) => item.prompt === firstPrompt && item.canceled === true),
      ).toBe(true);
      expect(
        retained?.items?.some((item) => item.prompt === secondPrompt && item.canceled === true),
      ).toBe(true);

      replaceSpy.mockRestore();
      originalReplace({ entries: retainedEntries ?? [] });
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(
        drainCalls.some(
          (run) =>
            run.canceled !== true &&
            (run.prompt === firstPrompt || run.prompt === secondPrompt) &&
            !run.abortSignal?.aborted,
        ),
      ).toBe(false);
    } finally {
      replaceSpy.mockRestore();
      releaseCollect.resolve();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("persists canceled overflow sources before dropping them", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-overflow-abort-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-overflow-abort-drop-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const abortedPrompt = "aborted overflow source";
    const drainCalls: FollowupRun[] = [];

    try {
      const aborter = new AbortController();
      const queue = getFollowupQueue(key, settings);
      const source = {
        ...createRun({
          prompt: abortedPrompt,
          originatingChannel: "telegram",
          originatingTo: "12345",
        }),
        abortSignal: aborter.signal,
      };
      queue.droppedCount = 1;
      queue.summaryLines = [abortedPrompt];
      queue.summarySources = [source];
      persistFollowupQueues();
      expect(followupQueueEntryContainsPrompt(key, abortedPrompt)).toBe(true);
      aborter.abort();

      scheduleFollowupDrain(key, async (run) => {
        drainCalls.push(run);
      });
      await vi.waitFor(() => {
        expect(followupQueueEntryContainsPrompt(key, abortedPrompt)).toBe(false);
      });

      expect(FOLLOWUP_QUEUES.get(key)?.summarySources ?? []).toEqual([]);
      expect(drainCalls.some((run) => run.prompt === abortedPrompt && run.canceled !== true)).toBe(
        false,
      );
    } finally {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("restores canceled overflow sources when acknowledgement fails and does not execute them after restart", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-overflow-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-overflow-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const abortedPrompt = "canceled-overflow-ack-fail";
    const drainCalls: FollowupRun[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let retainedEntries: Array<[string, unknown]> | undefined;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const hasAborted = params.entries.some(
          ([entryKey, data]) => entryKey === key && JSON.stringify(data).includes(abortedPrompt),
        );
        if (!hasAborted && retainedEntries === undefined) {
          retainedEntries = followupQueueSqlite.loadFollowupQueueEntries();
          throw new Error("injected sqlite acknowledgement failure");
        }
        originalReplace(params);
      });

    try {
      const aborter = new AbortController();
      const queue = getFollowupQueue(key, settings);
      queue.droppedCount = 1;
      queue.summaryLines = [abortedPrompt];
      queue.summarySources = [
        {
          ...createRun({
            prompt: abortedPrompt,
            originatingChannel: "telegram",
            originatingTo: "12345",
          }),
          abortSignal: aborter.signal,
        },
      ];
      persistFollowupQueues();
      expect(followupQueueEntryContainsPrompt(key, abortedPrompt)).toBe(true);
      aborter.abort();

      scheduleFollowupDrain(key, async (run) => {
        drainCalls.push(run);
      });
      await vi.waitFor(() => {
        expect(retainedEntries).toBeDefined();
      });

      const retained = retainedEntries?.find(([entryKey]) => entryKey === key)?.[1] as {
        summarySources?: Array<{ prompt?: string; canceled?: true }>;
      };
      expect(
        retained?.summarySources?.some(
          (item) => item.prompt === abortedPrompt && item.canceled === true,
        ),
      ).toBe(true);

      replaceSpy.mockRestore();
      originalReplace({ entries: retainedEntries ?? [] });
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.summarySources ?? []).toEqual([]);
      expect(peekRestoredPendingDrainKeys().has(key)).toBe(false);
      expect(drainCalls.some((run) => run.prompt === abortedPrompt && run.canceled !== true)).toBe(
        false,
      );
    } finally {
      replaceSpy.mockRestore();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("restores canceled overflow elisions when acknowledgement fails and does not execute them after restart", async () => {
    const tmpDir = tempDirs.make("openclaw-queue-elision-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-elision-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const abortedPrompt = "canceled-elision-ack-fail";
    const drainCalls: FollowupRun[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let retainedEntries: Array<[string, unknown]> | undefined;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const hasAborted = params.entries.some(
          ([entryKey, data]) => entryKey === key && JSON.stringify(data).includes(abortedPrompt),
        );
        if (!hasAborted && retainedEntries === undefined) {
          retainedEntries = followupQueueSqlite.loadFollowupQueueEntries();
          throw new Error("injected sqlite acknowledgement failure");
        }
        originalReplace(params);
      });

    try {
      const aborter = new AbortController();
      const queue = getFollowupQueue(key, settings);
      queue.droppedCount = 1;
      queue.summaryElisions = [
        {
          contextKey: "route-a",
          count: 1,
          sources: [
            {
              ...createRun({
                prompt: abortedPrompt,
                originatingChannel: "telegram",
                originatingTo: "12345",
              }),
              abortSignal: aborter.signal,
            },
          ],
          summaryLines: [abortedPrompt],
          sourceRefs: new WeakMap(),
        },
      ];
      persistFollowupQueues();
      expect(followupQueueEntryContainsPrompt(key, abortedPrompt)).toBe(true);
      aborter.abort();

      scheduleFollowupDrain(key, async (run) => {
        drainCalls.push(run);
      });
      await vi.waitFor(() => {
        expect(retainedEntries).toBeDefined();
      });

      const retained = retainedEntries?.find(([entryKey]) => entryKey === key)?.[1] as {
        summaryElisions?: Array<{ sources?: Array<{ prompt?: string; canceled?: true }> }>;
      };
      expect(
        retained?.summaryElisions?.some((elision) =>
          elision.sources?.some((item) => item.prompt === abortedPrompt && item.canceled === true),
        ),
      ).toBe(true);

      replaceSpy.mockRestore();
      originalReplace({ entries: retainedEntries ?? [] });
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.summaryElisions ?? []).toEqual([]);
      expect(peekRestoredPendingDrainKeys().has(key)).toBe(false);
      expect(drainCalls.some((run) => run.prompt === abortedPrompt && run.canceled !== true)).toBe(
        false,
      );
    } finally {
      replaceSpy.mockRestore();
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
