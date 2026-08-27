import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  followupQueueEntryContainsPrompt,
  hasFollowupQueueEntries,
  loadFollowupQueueEntries,
} from "../../infra/followup-queue-sqlite.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { kickFollowupDrainIfIdle, rememberFollowupDrainCallback } from "./queue/drain.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  hasPersistedFollowupQueues,
  restoreFollowupQueues,
} from "./queue/persist.js";
import { FOLLOWUP_QUEUES } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

// End-to-end persistence round-trip over the real shared SQLite state store. This is
// the closest in-process reproduction of the production scenario the followup
// queue guards: a channel message queued mid-turn, a gateway crash, and
// exactly-once redelivery on restart. The trigger (enqueue while a run is
// active) is lane-serialized in the live gateway and only reachable from inside
// the process, so the cycle is exercised here against the real persist/restore
// modules rather than over a live transport.
describe("followup queue restart round-trip (real shared SQLite state)", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("persists a mid-turn Telegram followup, restores it after a simulated restart, redelivers exactly once with routing intact, and does not replay after a second restart", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-tg-restart-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = "agent:main:telegram:direct:6300969793";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    // A real gateway crash/SIGKILL keeps only the on-disk state store; everything
    // else (in-memory queues, restore-once flag, pending-drain set) is gone.
    const simulateGatewayRestart = () => {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
    };

    try {
      // Hermetic start: CI runs this shard non-isolated, so FOLLOWUP_QUEUES and
      // the restore-once flag are shared across files. Reset our slice first so
      // a sibling test's leftover queue entry can't bleed into our assertions.
      simulateGatewayRestart();

      // 1. Mid-turn enqueue: a Telegram message arrives while a run is active.
      //    restartIfIdle=false mirrors agent-runner's enqueue-followup call,
      //    which queues the message behind the active turn instead of draining.
      enqueueFollowupRun(
        key,
        createRun({
          prompt: "summarize the thread so far",
          messageId: "tg-3987",
          originatingChannel: "telegram",
          originatingTo: "6300969793",
          originatingAccountId: "default",
        }),
        settings,
        "message-id",
        undefined,
        false,
      );

      // 2. persistFollowupQueues ran synchronously on enqueue: the shared SQLite
      //    row exists on disk and carries the Telegram routing needed to redeliver.
      expect(hasPersistedFollowupQueues()).toBe(true);
      expect(followupQueueEntryContainsPrompt(key, "summarize the thread so far")).toBe(true);
      const persistedEntry = loadFollowupQueueEntries().find(
        ([entryKey]) => entryKey === key,
      )?.[1] as
        | { items: { prompt: string; originatingChannel?: string; originatingTo?: string }[] }
        | undefined;
      const persistedItem = persistedEntry?.items[0];
      expect(persistedItem?.prompt).toBe("summarize the thread so far");
      expect(persistedItem?.originatingChannel).toBe("telegram");
      expect(persistedItem?.originatingTo).toBe("6300969793");

      // 3. Crash + restart: wipe process memory; only the disk store survives.
      simulateGatewayRestart();
      expect(FOLLOWUP_QUEUES.has(key)).toBe(false);

      // 4. restoreFollowupQueues reloads the queue from disk, routing intact.
      restoreFollowupQueues();
      const restored = FOLLOWUP_QUEUES.get(key);
      expect(restored?.items).toHaveLength(1);
      expect(restored?.items[0]?.prompt).toBe("summarize the thread so far");
      expect(restored?.items[0]?.originatingChannel).toBe("telegram");
      expect(restored?.items[0]?.originatingTo).toBe("6300969793");

      // 5. Drain via the idle-aware path; record every delivery to detect replay.
      //    SQLite keeps the row until settle-after-success so a crash mid-send
      //    can still redeliver; durable omit happens only after channel handoff.
      const deliveries: string[] = [];
      let persistedDuringSend = false;
      rememberFollowupDrainCallback(key, async (run) => {
        persistedDuringSend = followupQueueEntryContainsPrompt(key, run.prompt);
        deliveries.push(run.prompt);
      });
      kickFollowupDrainIfIdle(key);

      // Wait for the drain to fully settle: it delivers, removes the item, and
      // persists the acknowledgement. Poll shared SQLite until our key is
      // gone (or empty) so the no-replay check below sees the acked state.
      const keyDrainedOnDisk = () => {
        if (!hasFollowupQueueEntries()) {
          return true;
        }
        const entry = loadFollowupQueueEntries().find(([entryKey]) => entryKey === key)?.[1] as
          | { items?: unknown[] }
          | undefined;
        return !entry || (entry.items?.length ?? 0) === 0;
      };
      const deadline = Date.now() + 5_000;
      while (!keyDrainedOnDisk() && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      // 6. Exactly-once: the restored message was redelivered a single time and
      //    the in-memory queue is now empty. SQLite stayed durable during send.
      expect(deliveries).toEqual(["summarize the thread so far"]);
      expect(persistedDuringSend).toBe(true);
      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toHaveLength(0);

      // 7. The drain acknowledgement persisted the now-empty queue, so a SECOND
      //    crash + restore must NOT replay the already-delivered message.
      simulateGatewayRestart();
      restoreFollowupQueues();
      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toHaveLength(0);
    } finally {
      simulateGatewayRestart();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("drains restored identity-less collect entries from two senders individually", async () => {
    const tmpDir = tempDirs.make("openclaw-followup-collect-restore-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = "agent:main:telegram:group:collect-restore";
    const settings: QueueSettings = { mode: "collect", debounceMs: 0, cap: 50 };
    const simulateGatewayRestart = () => {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
    };

    try {
      simulateGatewayRestart();
      for (const senderId of ["user-1", "user-2"]) {
        const item = createRun({
          prompt: `from ${senderId}`,
          originatingChannel: "telegram",
          originatingTo: "12345",
        });
        enqueueFollowupRun(
          key,
          { ...item, run: { ...item.run, senderId, senderIsOwner: false } },
          settings,
          "message-id",
          undefined,
          false,
        );
      }
      expect(followupQueueEntryContainsPrompt(key, "from user-1")).toBe(true);
      expect(followupQueueEntryContainsPrompt(key, "from user-2")).toBe(true);

      simulateGatewayRestart();
      restoreFollowupQueues();
      const restored = FOLLOWUP_QUEUES.get(key);
      expect(restored?.items).toHaveLength(2);
      expect(restored?.items.every((item) => item.disableCollectBatching === true)).toBe(true);
      expect(restored?.items.every((item) => item.run.senderId === undefined)).toBe(true);

      const deliveries: FollowupRun[] = [];
      rememberFollowupDrainCallback(key, async (run) => {
        deliveries.push(run);
      });
      kickFollowupDrainIfIdle(key);

      const keyDrainedOnDisk = () => {
        if (!hasFollowupQueueEntries()) {
          return true;
        }
        const entry = loadFollowupQueueEntries().find(([entryKey]) => entryKey === key)?.[1] as
          | { items?: unknown[] }
          | undefined;
        return !entry || (entry.items?.length ?? 0) === 0;
      };
      const deadline = Date.now() + 5_000;
      while (!keyDrainedOnDisk() && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }

      expect(deliveries).toHaveLength(2);
      expect(deliveries.map((run) => run.prompt)).toEqual(["from user-1", "from user-2"]);
      expect(
        deliveries.every((run) => !run.prompt.includes("[Queued messages while agent was busy]")),
      ).toBe(true);
      expect(FOLLOWUP_QUEUES.get(key)?.items ?? []).toHaveLength(0);
    } finally {
      simulateGatewayRestart();
      if (originalStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });
});
