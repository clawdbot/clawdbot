import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSessionQueues, enqueueFollowupRun, scheduleFollowupDrain } from "../queue.js";
import { createQueueTestRun, installQueueRuntimeErrorSilencer } from "../queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./drain.js";
import type { FollowupRun, QueueSettings } from "./types.js";

installQueueRuntimeErrorSilencer();

describe("delegated auth followup isolation", () => {
  const keysToCleanup: string[] = [];

  afterEach(() => {
    if (keysToCleanup.length > 0) {
      clearSessionQueues(keysToCleanup.splice(0));
    }
  });

  it("keeps delegated auth on its individual collect-mode run", async () => {
    const key = `test-delegated-auth-${Date.now()}-${Math.random()}`;
    keysToCleanup.push(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0, cap: 50 };
    const pluginAuth = {
      getDelegatedAccessToken: vi.fn(async () => ({
        ok: false as const,
        reason: "missing_consent" as const,
      })),
    };
    const calls: FollowupRun[] = [];
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
    };
    const queued = createQueueTestRun({ prompt: "use delegated access" });
    queued.run.pluginAuth = pluginAuth;

    enqueueFollowupRun(key, queued, settings, "message-id", runFollowup);
    scheduleFollowupDrain(key, runFollowup);

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]?.run.pluginAuth).toBe(pluginAuth);
  });

  it("removes delegated auth from synthetic overflow summaries", () => {
    const source = createQueueTestRun({ prompt: "original turn" });
    source.run.pluginAuth = {
      getDelegatedAccessToken: vi.fn(async () => ({
        ok: false as const,
        reason: "missing_consent" as const,
      })),
    };

    const synthetic = createOverflowSummaryRetrySource(source);

    expect(synthetic.run.pluginAuth).toBeUndefined();
    expect(source.run.pluginAuth).toBeDefined();
  });
});
