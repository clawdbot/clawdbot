import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  followupQueueEntryContainsPrompt,
  loadFollowupQueueEntries,
} from "../../infra/followup-queue-sqlite.js";
import type { QueueSettings } from "./queue.js";
import { enqueueFollowupRun } from "./queue.js";
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

describe("followup queue restart exec policy", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("restores a live restrictive exec overlay after persist+restore", () => {
    const tmpDir = tempDirs.make("openclaw-followup-exec-policy-");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;

    const key = "agent:main:telegram:direct:6300969793";
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const simulateGatewayRestart = () => {
      FOLLOWUP_QUEUES.delete(key);
      clearRestoredPendingDrainKeysForTest();
      clearFollowupQueuesRestoredFlagForTest();
    };

    try {
      simulateGatewayRestart();

      const queued = createRun({
        prompt: "stay denied after restart",
        messageId: "tg-exec-deny",
        originatingChannel: "telegram",
        originatingTo: "6300969793",
        originatingAccountId: "default",
      });
      queued.run.execOverrides = { host: "gateway", security: "deny", ask: "always" };

      enqueueFollowupRun(key, queued, settings, "message-id", undefined, false);

      const persisted = loadFollowupQueueEntries().find(([entryKey]) => entryKey === key)?.[1] as {
        items?: Array<{ run?: { execOverrides?: unknown } }>;
      };
      expect(persisted?.items?.[0]?.run?.execOverrides).toEqual({
        security: "deny",
        ask: "always",
      });
      expect(followupQueueEntryContainsPrompt(key, "stay denied after restart")).toBe(true);

      simulateGatewayRestart();
      restoreFollowupQueues();

      const restored = FOLLOWUP_QUEUES.get(key)?.items[0];
      expect(restored?.prompt).toBe("stay denied after restart");
      expect(restored?.run.execOverrides).toEqual({ security: "deny", ask: "always" });
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
