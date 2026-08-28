import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as followupQueueSqlite from "../../infra/followup-queue-sqlite.js";
import { followupQueueEntryContainsPrompt } from "../../infra/followup-queue-sqlite.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  enqueueFollowupRun,
  FollowupTerminalDeliveryError,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  restoreFollowupQueues,
} from "./queue/persist.js";
import { FOLLOWUP_QUEUES } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

describe("followup queue failed terminal delivery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("does not tombstone delivered or replay after a failed final delivery", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-delivery-discard-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-delivery-discard-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const prompt = "undelivered-after-execution";
    const calls: FollowupRun[] = [];

    try {
      enqueueFollowupRun(key, createRun({ prompt }), settings, "message-id", undefined, false);
      expect(followupQueueEntryContainsPrompt(key, prompt)).toBe(true);

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        throw new FollowupTerminalDeliveryError("channel send failed");
      });

      await vi.waitFor(() => {
        expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      });

      expect(calls).toHaveLength(1);
      expect(followupQueueEntryContainsPrompt(key, prompt)).toBe(false);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(followupQueueEntryContainsPrompt(key, prompt)).toBe(false);
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

  it("keeps a single-drain discard in memory when acknowledgement fails and does not re-run it", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-discard-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-delivery-discard-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const prompt = "undelivered-ack-fail";
    const calls: FollowupRun[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let failedOnce = false;
    let discardedAtFailure: boolean | undefined;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const hasDiscarded = params.entries.some(
          ([entryKey, data]) =>
            entryKey === key && JSON.stringify(data).includes('"discarded":true'),
        );
        if (hasDiscarded && !failedOnce) {
          failedOnce = true;
          discardedAtFailure = (FOLLOWUP_QUEUES.get(key)?.items ?? []).some(
            (item) => item.prompt === prompt && item.discarded === true,
          );
          throw new Error("injected sqlite acknowledgement failure");
        }
        originalReplace(params);
      });

    try {
      enqueueFollowupRun(key, createRun({ prompt }), settings, "message-id", undefined, false);
      expect(followupQueueEntryContainsPrompt(key, prompt)).toBe(true);

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        throw new FollowupTerminalDeliveryError("channel send failed");
      });

      await vi.waitFor(() => {
        expect(failedOnce).toBe(true);
      });
      expect(calls).toHaveLength(1);
      expect(discardedAtFailure).toBe(true);

      await vi.waitFor(() => {
        expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      });
      expect(calls).toHaveLength(1);
      expect(followupQueueEntryContainsPrompt(key, prompt)).toBe(false);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(followupQueueEntryContainsPrompt(key, prompt)).toBe(false);
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

  it("keeps collect-drain discards in memory when acknowledgement fails and does not re-run them", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-collect-discard-ack-fail-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = `test-collect-discard-ack-fail-${Date.now()}`;
    const settings: QueueSettings = { mode: "collect", debounceMs: 0, cap: 50 };
    const firstPrompt = "collect-undelivered-first";
    const secondPrompt = "collect-undelivered-second";
    const calls: FollowupRun[] = [];
    const originalReplace = followupQueueSqlite.replaceFollowupQueueEntries;
    let failedOnce = false;
    let discardedAtFailure = 0;
    const replaceSpy = vi
      .spyOn(followupQueueSqlite, "replaceFollowupQueueEntries")
      .mockImplementation((params) => {
        const hasDiscarded = params.entries.some(
          ([entryKey, data]) =>
            entryKey === key && JSON.stringify(data).includes('"discarded":true'),
        );
        if (hasDiscarded && !failedOnce) {
          failedOnce = true;
          discardedAtFailure = (FOLLOWUP_QUEUES.get(key)?.items ?? []).filter(
            (item) => item.discarded === true,
          ).length;
          throw new Error("injected sqlite acknowledgement failure");
        }
        originalReplace(params);
      });

    try {
      enqueueFollowupRun(
        key,
        createRun({
          prompt: firstPrompt,
          originatingChannel: "telegram",
          originatingTo: "12345",
        }),
        settings,
      );
      enqueueFollowupRun(
        key,
        createRun({
          prompt: secondPrompt,
          originatingChannel: "telegram",
          originatingTo: "12345",
        }),
        settings,
      );
      expect(followupQueueEntryContainsPrompt(key, firstPrompt)).toBe(true);
      expect(followupQueueEntryContainsPrompt(key, secondPrompt)).toBe(true);

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        throw new FollowupTerminalDeliveryError("channel send failed");
      });

      await vi.waitFor(() => {
        expect(failedOnce).toBe(true);
      });
      expect(calls).toHaveLength(1);
      expect(discardedAtFailure).toBe(2);

      await vi.waitFor(() => {
        expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      });
      expect(calls).toHaveLength(1);
      expect(followupQueueEntryContainsPrompt(key, firstPrompt)).toBe(false);
      expect(followupQueueEntryContainsPrompt(key, secondPrompt)).toBe(false);

      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
      restoreFollowupQueues();

      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toEqual([]);
      expect(followupQueueEntryContainsPrompt(key, firstPrompt)).toBe(false);
      expect(followupQueueEntryContainsPrompt(key, secondPrompt)).toBe(false);
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
