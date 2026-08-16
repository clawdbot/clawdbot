// Tests follow-up queue message-id dedupe and drain scheduling behavior.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
  clearSessionQueues,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resetRecentQueuedMessageIdDedupe } from "./queue/enqueue.test-support.js";

installQueueRuntimeErrorSilencer();

const collectSettings: QueueSettings = {
  mode: "collect",
  debounceMs: 0,
  cap: 50,
  dropPolicy: "summarize",
};

function createFollowupCollector(expectedCalls = 1): {
  calls: FollowupRun[];
  done: ReturnType<typeof createDeferred<void>>;
  runFollowup: (run: FollowupRun) => Promise<void>;
} {
  const calls: FollowupRun[] = [];
  const done = createDeferred();
  return {
    calls,
    done,
    runFollowup: async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    },
  };
}

describe("followup queue deduplication", () => {
  beforeEach(() => {
    resetRecentQueuedMessageIdDedupe();
  });

  it("deduplicates messages with same Discord message_id", async () => {
    const key = `test-dedup-message-id-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] Hello (dupe)",
        messageId: "m1",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(second).toBe(false);

    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "[Discord Guild #test channel id:123] World",
        messageId: "m2",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(third).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
  });

  it("deduplicates message ids when numeric and string thread ids share a route", () => {
    const key = `test-dedup-thread-normalized-${Date.now()}`;

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: 42.9,
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        messageId: "same-id",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: "42",
      }),
      collectSettings,
    );
    expect(second).toBe(false);
  });

  it("deduplicates same message_id after queue drain restarts", async () => {
    const key = `test-dedup-after-drain-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const redelivery = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first-redelivery",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "+10000000000",
      }),
      collectSettings,
    );

    expect(redelivery).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("deduplicates redelivery after reply policy changes", async () => {
    const key = `test-dedup-policy-change-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    expect(
      enqueueFollowupRun(
        key,
        createRun({
          prompt: "first",
          messageId: "same-id",
          originatingChannel: "slack",
          originatingTo: "U123",
          originatingReplyToId: "101.001",
          originatingReplyToMode: "off",
          originatingChatType: "direct",
        }),
        collectSettings,
      ),
    ).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(
      enqueueFollowupRun(
        key,
        createRun({
          prompt: "redelivery",
          messageId: "same-id",
          originatingChannel: "slack",
          originatingTo: "U123",
          originatingReplyToId: "101.001",
          originatingReplyToMode: "first",
          originatingChatType: "direct",
        }),
        collectSettings,
      ),
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("deduplicates same message_id across distinct enqueue module instances", async () => {
    const enqueueA = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-b",
    );
    const key = `test-dedup-cross-module-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    resetRecentQueuedMessageIdDedupe();

    try {
      expect(
        enqueueA.enqueueFollowupRun(
          key,
          createRun({
            prompt: "first",
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
          }),
          collectSettings,
        ),
      ).toBe(true);

      scheduleFollowupDrain(key, runFollowup);
      await done.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(
        enqueueB.enqueueFollowupRun(
          key,
          createRun({
            prompt: "first-redelivery",
            messageId: "same-id",
            originatingChannel: "signal",
            originatingTo: "+10000000000",
          }),
          collectSettings,
        ),
      ).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      clearSessionQueues([key]);
      resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not collide recent message-id keys when routing contains delimiters", async () => {
    const key = `test-dedup-key-collision-${Date.now()}`;
    const { done, runFollowup } = createFollowupCollector();

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "signal|group",
        originatingTo: "peer",
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        messageId: "same-id",
        originatingChannel: "signal",
        originatingTo: "group|peer",
      }),
      collectSettings,
    );
    expect(second).toBe(true);
  });

  it("deduplicates exact prompt when routing matches and no message id", () => {
    const key = `test-dedup-whatsapp-${Date.now()}`;

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      collectSettings,
    );
    expect(second).toBe(true);

    const third = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world 2",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      collectSettings,
    );
    expect(third).toBe(true);
  });

  it("does not deduplicate across different providers without message id", () => {
    const key = `test-dedup-cross-provider-${Date.now()}`;

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Same text",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      collectSettings,
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Same text",
        originatingChannel: "discord",
        originatingTo: "channel:123",
      }),
      collectSettings,
    );
    expect(second).toBe(true);
  });

  it("allows re-enqueueing a message whose queued run was abandoned before admission", () => {
    const key = `test-dedup-abandoned-retry-${Date.now()}`;
    const onAbandoned = vi.fn();
    const first = createRun({
      prompt: "first",
      messageId: "same-id",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    first.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned };
    expect(enqueueFollowupRun(key, first, collectSettings)).toBe(true);

    // Queue teardown drops the un-admitted run; durable ingress releases the
    // claim for retry when onAbandoned fires.
    clearSessionQueues([key]);
    expect(onAbandoned).toHaveBeenCalledTimes(1);

    // The ingress retry redelivers the same message id on the same route. It
    // must be admitted again instead of silently rejected as a duplicate.
    const retry = createRun({
      prompt: "first",
      messageId: "same-id",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    retry.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(enqueueFollowupRun(key, retry, collectSettings)).toBe(true);
    clearSessionQueues([key]);
  });

  it("allows re-enqueueing a message evicted by old-item queue overflow", () => {
    const key = `test-dedup-evicted-retry-${Date.now()}`;
    const evictSettings: QueueSettings = { mode: "collect", cap: 1, dropPolicy: "old" };
    const onAbandoned = vi.fn();
    const onDisposition = vi.fn();
    const first = createRun({
      prompt: "first",
      messageId: "m1",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    first.onQueueDisposition = onDisposition;
    first.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned };
    expect(enqueueFollowupRun(key, first, evictSettings)).toBe(true);

    // A newer message overflows the cap; the oldest un-admitted run is evicted
    // and its claim is released for retry.
    expect(
      enqueueFollowupRun(
        key,
        createRun({
          prompt: "second",
          messageId: "m2",
          originatingChannel: "line",
          originatingTo: "group:G1",
        }),
        evictSettings,
      ),
    ).toBe(true);
    expect(onDisposition).toHaveBeenCalledWith("queue-cap-old");
    expect(onAbandoned).toHaveBeenCalledOnce();

    const retry = createRun({
      prompt: "first",
      messageId: "m1",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    retry.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(enqueueFollowupRun(key, retry, evictSettings)).toBe(true);
    clearSessionQueues([key]);
  });

  it("allows re-enqueueing a message compacted into a summary elision before teardown", () => {
    const key = `test-dedup-elision-retry-${Date.now()}`;
    const summarizeSettings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const onAbandoned = vi.fn();
    const first = createRun({
      prompt: "first",
      messageId: "m1",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    first.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned };
    expect(enqueueFollowupRun(key, first, summarizeSettings)).toBe(true);

    // Overflow the cap twice: the first enqueue drops `first` into the summary
    // sources, the second compacts it into a summary elision. Compaction clones
    // the run (createOverflowSummaryRetrySource), so from here on completion
    // sees the clone, not the originally recorded run object.
    for (const [prompt, messageId] of [
      ["second", "m2"],
      ["third", "m3"],
    ] as const) {
      expect(
        enqueueFollowupRun(
          key,
          createRun({ prompt, messageId, originatingChannel: "line", originatingTo: "group:G1" }),
          summarizeSettings,
        ),
      ).toBe(true);
    }

    // Teardown abandons the elided run via its clone; the ingress retry for the
    // original message id must still be re-admittable.
    clearSessionQueues([key]);
    expect(onAbandoned).toHaveBeenCalledTimes(1);

    const retry = createRun({
      prompt: "first",
      messageId: "m1",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    retry.turnAdoptionLifecycle = { onAdopted: () => {} };
    expect(enqueueFollowupRun(key, retry, summarizeSettings)).toBe(true);
    clearSessionQueues([key]);
  });

  it("does not let a stale abandoned lifecycle release a newer same-id owner", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
      const key = "test-dedup-stale-owner";
      const stalledAdmission = createDeferred();
      const first = createRun({
        prompt: "first",
        messageId: "same-id",
        originatingChannel: "line",
        originatingTo: "group:G1",
      });
      first.turnAdoptionLifecycle = {
        onAdopted: () => stalledAdmission.promise,
        onAbandoned: vi.fn(),
      };
      expect(enqueueFollowupRun(key, first, collectSettings)).toBe(true);

      const admission = admitFollowupRunLifecycle(first);
      await vi.advanceTimersByTimeAsync(0);
      clearSessionQueues([key]);

      // Once the original key expires, a later delivery can legitimately own
      // the same identity while the old lifecycle is still settling.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      const replacement = createRun({
        prompt: "replacement",
        messageId: "same-id",
        originatingChannel: "line",
        originatingTo: "group:G1",
      });
      replacement.turnAdoptionLifecycle = { onAdopted: () => {} };
      expect(enqueueFollowupRun(key, replacement, collectSettings)).toBe(true);

      stalledAdmission.reject(new Error("admission failed"));
      await expect(admission).rejects.toThrow("admission failed");
      await vi.advanceTimersByTimeAsync(0);

      const redelivery = createRun({
        prompt: "duplicate",
        messageId: "same-id",
        originatingChannel: "line",
        originatingTo: "group:G1",
      });
      expect(enqueueFollowupRun(key, redelivery, collectSettings)).toBe(false);
      clearSessionQueues([key]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still deduplicates redelivery of a message whose queued run was admitted", async () => {
    const key = `test-dedup-admitted-redelivery-${Date.now()}`;
    const onAbandoned = vi.fn();
    const run = createRun({
      prompt: "first",
      messageId: "same-id",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    run.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned };
    expect(enqueueFollowupRun(key, run, collectSettings)).toBe(true);

    await admitFollowupRunLifecycle(run);
    completeFollowupRunLifecycle(run);
    expect(onAbandoned).not.toHaveBeenCalled();
    clearSessionQueues([key]);

    const redelivery = createRun({
      prompt: "first-redelivery",
      messageId: "same-id",
      originatingChannel: "line",
      originatingTo: "group:G1",
    });
    expect(enqueueFollowupRun(key, redelivery, collectSettings)).toBe(false);
  });

  it("can opt-in to prompt-based dedupe when message id is absent", () => {
    const key = `test-dedup-prompt-mode-${Date.now()}`;

    const first = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      collectSettings,
      "prompt",
    );
    expect(first).toBe(true);

    const second = enqueueFollowupRun(
      key,
      createRun({
        prompt: "Hello world",
        originatingChannel: "whatsapp",
        originatingTo: "+1234567890",
      }),
      collectSettings,
      "prompt",
    );
    expect(second).toBe(false);
  });
});
