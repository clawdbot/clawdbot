import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import {
  createDeferred,
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

describe("followup queue drain restart after idle window", () => {
  it("does not retain stale callbacks when scheduleFollowupDrain runs with an empty queue", async () => {
    const key = `test-no-stale-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];
    const drained = createDeferred<void>();

    scheduleFollowupDrain(key, async (run) => {
      staleCalls.push(run);
    });

    enqueueFollowupRun(key, createRun({ prompt: "after-empty-schedule" }), settings);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(staleCalls).toHaveLength(0);

    scheduleFollowupDrain(key, async (run) => {
      freshCalls.push(run);
      drained.resolve();
    });
    await drained.promise;

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.prompt).toBe("after-empty-schedule");
  });

  it("processes a message enqueued after the drain empties when enqueue refreshes the callback", async () => {
    const key = `test-idle-window-race-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const firstProcessed = createDeferred<void>();
    const secondProcessed = createDeferred<void>();
    let callCount = 0;
    const runFollowup = async (run: FollowupRun) => {
      callCount++;
      calls.push(run);
      if (callCount === 1) {
        firstProcessed.resolve();
      }
      if (callCount === 2) {
        secondProcessed.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      settings,
      "message-id",
      runFollowup,
    );

    await secondProcessed.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("before-idle");
    expect(calls[1]?.prompt).toBe("after-idle");
  });

  it("restarts an idle drain with the newest followup callback", async () => {
    const key = `test-idle-window-fresh-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];
    const firstProcessed = createDeferred<void>();
    const secondProcessed = createDeferred<void>();

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
      if (staleCalls.length === 1) {
        firstProcessed.resolve();
      }
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
      secondProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, staleFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    enqueueFollowupRun(
      key,
      createRun({ prompt: "after-idle" }),
      settings,
      "message-id",
      freshFollowup,
    );
    await secondProcessed.promise;

    expect(staleCalls).toHaveLength(1);
    expect(staleCalls[0]?.prompt).toBe("before-idle");
    expect(freshCalls).toHaveLength(1);
    expect(freshCalls[0]?.prompt).toBe("after-idle");
  });

  it("does not auto-start a drain when a busy run only refreshes the callback", async () => {
    const key = `test-busy-run-refreshes-callback-${Date.now()}`;
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const staleCalls: FollowupRun[] = [];
    const freshCalls: FollowupRun[] = [];

    const staleFollowup = async (run: FollowupRun) => {
      staleCalls.push(run);
    };
    const freshFollowup = async (run: FollowupRun) => {
      freshCalls.push(run);
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "queued-while-busy" }),
      settings,
      "message-id",
      freshFollowup,
      false,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(freshCalls).toHaveLength(0);

    scheduleFollowupDrain(key, staleFollowup);
    await vi.waitFor(() => {
      expect(freshCalls).toHaveLength(1);
    });

    expect(staleCalls).toHaveLength(0);
    expect(freshCalls[0]?.prompt).toBe("queued-while-busy");
  });

  it("restarts an idle drain across distinct enqueue and drain module instances when enqueue refreshes the callback", async () => {
    const drainA = await importFreshModule<typeof import("./queue/drain.js")>(
      import.meta.url,
      "./queue/drain.js?scope=restart-a",
    );
    const enqueueB = await importFreshModule<typeof import("./queue/enqueue.js")>(
      import.meta.url,
      "./queue/enqueue.js?scope=restart-b",
    );
    const { clearSessionQueues } = await import("./queue.js");
    const key = `test-idle-window-cross-module-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred<void>();

    enqueueB.resetRecentQueuedMessageIdDedupe();

    try {
      const runFollowup = async (run: FollowupRun) => {
        calls.push(run);
        if (calls.length === 1) {
          firstProcessed.resolve();
        }
      };

      enqueueB.enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
      drainA.scheduleFollowupDrain(key, runFollowup);
      await firstProcessed.promise;

      await new Promise<void>((resolve) => setImmediate(resolve));

      enqueueB.enqueueFollowupRun(
        key,
        createRun({ prompt: "after-idle" }),
        settings,
        "message-id",
        runFollowup,
      );

      await vi.waitFor(
        () => {
          expect(calls).toHaveLength(2);
        },
        { timeout: 1_000 },
      );

      expect(calls[0]?.prompt).toBe("before-idle");
      expect(calls[1]?.prompt).toBe("after-idle");
    } finally {
      clearSessionQueues([key]);
      drainA.clearFollowupDrainCallback(key);
      enqueueB.resetRecentQueuedMessageIdDedupe();
    }
  });

  it("does not double-drain when a message arrives while drain is still running", async () => {
    const key = `test-no-double-drain-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const allProcessed = createDeferred<void>();
    let runFollowupResolve: (() => void) | undefined;
    const runFollowupGate = new Promise<void>((res) => {
      runFollowupResolve = res;
    });
    const runFollowup = async (run: FollowupRun) => {
      await runFollowupGate;
      calls.push(run);
      if (calls.length >= 2) {
        allProcessed.resolve();
      }
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);
    if (!runFollowupResolve) {
      throw new Error("Expected followup run release callback to be initialized");
    }
    runFollowupResolve();

    await allProcessed.promise;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("first");
    expect(calls[1]?.prompt).toBe("second");
  });

  it("keeps a deferred followup queued and retries with the remembered callback", async () => {
    const key = `test-deferred-followup-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const retried = createDeferred<void>();
    let attempts = 0;

    const runFollowup = async (run: FollowupRun) => {
      attempts++;
      calls.push(run);
      if (attempts === 1) {
        throw new FollowupRunDeferredError("reply lane busy");
      }
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "wait-for-lane" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    await retried.promise;

    expect(attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("wait-for-lane");
    expect(calls[1]?.prompt).toBe("wait-for-lane");
  });

  it("preserves overflow summaries across deferred retries", async () => {
    const key = `test-deferred-summary-retry-${Date.now()}`;
    const prompts: string[] = [];
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const retried = createDeferred<void>();
    let attempts = 0;

    const runFollowup = async (run: FollowupRun) => {
      attempts++;
      prompts.push(run.prompt);
      if (attempts === 1) {
        throw new FollowupRunDeferredError("reply lane busy");
      }
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "dropped while busy" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "kept while busy" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    await retried.promise;

    expect(attempts).toBe(2);
    expect(prompts[0]).toContain("Dropped 1 message");
    expect(prompts[0]).toContain("dropped while busy");
    expect(prompts[1]).toContain("Dropped 1 message");
    expect(prompts[1]).toContain("dropped while busy");
  });

  it("merges overflow summaries added while a deferred retry is waiting", async () => {
    const key = `test-deferred-summary-merge-${Date.now()}`;
    const prompts: string[] = [];
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    const retried = createDeferred<void>();
    let attempts = 0;

    const runFollowup = async (run: FollowupRun) => {
      attempts++;
      prompts.push(run.prompt);
      if (attempts === 1) {
        enqueueFollowupRun(key, createRun({ prompt: "newer dropped while waiting" }), settings);
        enqueueFollowupRun(key, createRun({ prompt: "newer kept while waiting" }), settings);
        throw new FollowupRunDeferredError("reply lane busy");
      }
      retried.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "original dropped while busy" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "original kept while busy" }), settings);
    scheduleFollowupDrain(key, runFollowup);

    await retried.promise;

    expect(attempts).toBe(2);
    expect(prompts[1]).toContain("Dropped 3 messages");
    expect(prompts[1]).toContain("original dropped while busy");
    expect(prompts[1]).toContain("newer dropped while waiting");
  });

  it("does not process messages after clearSessionQueues clears the callback", async () => {
    const key = `test-clear-callback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };

    const firstProcessed = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      firstProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-clear" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const { clearSessionQueues } = await import("./queue.js");
    clearSessionQueues([key]);

    enqueueFollowupRun(key, createRun({ prompt: "after-clear" }), settings);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("before-clear");
  });

  it("clears the remembered callback after a queue drains fully", async () => {
    const key = `test-auto-clear-callback-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const settings: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
    const firstProcessed = createDeferred<void>();

    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      firstProcessed.resolve();
    };

    enqueueFollowupRun(key, createRun({ prompt: "before-idle" }), settings);
    scheduleFollowupDrain(key, runFollowup);
    await firstProcessed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    enqueueFollowupRun(key, createRun({ prompt: "after-idle" }), settings);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("before-idle");
  });
});
