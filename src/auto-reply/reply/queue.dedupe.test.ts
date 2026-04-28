import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  enqueueFollowupRun,
  resetRecentQueuedMessageIdDedupe,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createDeferred,
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

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
  const done = createDeferred<void>();
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

  it("deduplicates message ids when numeric and string thread ids share a route", async () => {
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

  it("deduplicates same message_id across distinct enqueue module instances", async () => {
    const enqueueA = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=dedupe-b",
    );
    const { clearSessionQueues } = await import("./queue.js");
    const key = `test-dedup-cross-module-${Date.now()}`;
    const { calls, done, runFollowup } = createFollowupCollector();

    enqueueA.resetRecentQueuedMessageIdDedupe();
    enqueueB.resetRecentQueuedMessageIdDedupe();

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
      await new Promise<void>((resolve) => setImmediate(resolve));

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
      enqueueA.resetRecentQueuedMessageIdDedupe();
      enqueueB.resetRecentQueuedMessageIdDedupe();
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

  it("deduplicates exact prompt when routing matches and no message id", async () => {
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

  it("does not deduplicate across different providers without message id", async () => {
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

  it("can opt-in to prompt-based dedupe when message id is absent", async () => {
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
