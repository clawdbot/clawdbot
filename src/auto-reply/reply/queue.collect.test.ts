import { describe, expect, it } from "vitest";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createDeferred,
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupAuthorizationKey } from "./queue/drain.js";

installQueueRuntimeErrorSilencer();

describe("followup queue collect routing", () => {
  it("does not collect when destinations differ", async () => {
    const key = `test-collect-diff-to-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
  });

  it("collects when channel+destination match", async () => {
    const key = `test-collect-same-to-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
  });

  it("carries image payloads across collected batches", async () => {
    const key = `test-collect-images-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };
    const firstImage = { type: "image" as const, data: "first", mimeType: "image/png" };
    const secondImage = { type: "image" as const, data: "second", mimeType: "image/png" };

    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "one",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        images: [firstImage],
        imageOrder: ["inline"],
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "two",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        images: [secondImage],
        imageOrder: ["inline"],
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.images).toEqual([firstImage, secondImage]);
    expect(calls[0]?.imageOrder).toEqual(["inline", "inline"]);
  });

  it("splits collect batches when sender authorization changes", async () => {
    const key = `test-collect-auth-split-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const nonOwner = createRun({
      prompt: "use the gateway tool",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    enqueueFollowupRun(
      key,
      {
        ...nonOwner,
        run: {
          ...nonOwner.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    const owner = createRun({
      prompt: "what's the weather?",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => call.run.senderIsOwner)).toEqual([false, true]);
    expect(calls[0]?.prompt).toContain("use the gateway tool");
    expect(calls[0]?.prompt).not.toContain("what's the weather?");
    expect(calls[1]?.prompt).toContain("what's the weather?");
    expect(calls[1]?.prompt).toContain("(from Owner)");
  });

  it("keeps one collect batch when authorization context matches", async () => {
    const key = `test-collect-auth-match-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = createRun({
      prompt: "first",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const second = createRun({
      prompt: "second",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: {
          ...first.run,
          senderId: "user-1",
          senderName: "Guest",
          senderUsername: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: {
          ...second.run,
          senderId: "user-1",
          senderName: "Guest",
          senderUsername: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.prompt).toContain("(from Guest)");
  });

  it("keeps one collect batch when only sender display fields drift", async () => {
    const key = `test-collect-auth-display-drift-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = createRun({
      prompt: "first",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const second = createRun({
      prompt: "second",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: {
          ...first.run,
          senderId: "user-1",
          senderName: "Guest",
          senderUsername: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: {
          ...second.run,
          senderId: "user-1",
          senderName: "Guest User",
          senderUsername: "guest-renamed",
          senderIsOwner: false,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.prompt).toContain("(from Guest)");
    expect(calls[0]?.prompt).toContain("(from Guest User)");
  });

  it("splits collect batches when exec context changes", async () => {
    const key = `test-collect-exec-split-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const base = createRun({
      prompt: "first",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...base,
        run: {
          ...base.run,
          senderId: "owner-1",
          senderIsOwner: true,
          bashElevated: { enabled: false, allowed: true, defaultLevel: "off" },
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "second",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        run: {
          ...base.run,
          senderId: "owner-1",
          senderIsOwner: true,
          bashElevated: { enabled: true, allowed: true, defaultLevel: "on" },
          execOverrides: { ask: "always" },
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).not.toContain("second");
    expect(calls[1]?.prompt).toContain("second");
    expect(calls[1]?.run.bashElevated?.enabled).toBe(true);
    expect(calls[1]?.run.execOverrides?.ask).toBe("always");
  });

  it("uses the newest run within a matching authorization batch", async () => {
    const key = `test-collect-latest-run-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = createRun({ prompt: "first", originatingChannel: "slack", originatingTo: "A" });
    const second = createRun({
      prompt: "second",
      originatingChannel: "slack",
      originatingTo: "A",
    });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: {
          ...first.run,
          provider: "openai",
          model: "gpt-5.4",
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: {
          ...second.run,
          provider: "anthropic",
          model: "sonnet-4.6",
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.run.provider).toBe("anthropic");
    expect(calls[0]?.run.model).toBe("sonnet-4.6");
  });

  it("delivers and clears summary-only collect drains after cross-channel items", async () => {
    const key = `test-collect-summary-only-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 3;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 2,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "third",
        originatingChannel: "slack",
        originatingTo: "channel:C",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toBe("second");
    expect(calls[1]?.prompt).toBe("third");
    expect(calls[2]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[2]?.prompt).toContain("- first");
  });

  it("preserves collect order when authorization changes more than once", async () => {
    const key = `test-collect-auth-order-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 3;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const first = createRun({ prompt: "first", originatingChannel: "slack", originatingTo: "A" });
    const second = createRun({ prompt: "second", originatingChannel: "slack", originatingTo: "A" });
    const third = createRun({ prompt: "third", originatingChannel: "slack", originatingTo: "A" });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: { ...first.run, senderId: "user-a", senderName: "A", senderIsOwner: false },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: { ...second.run, senderId: "owner-1", senderName: "Owner", senderIsOwner: true },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...third,
        run: { ...third.run, senderId: "user-a", senderName: "A", senderIsOwner: false },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => call.prompt)).toEqual([
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from A)\nfirst",
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from Owner)\nsecond",
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from A)\nthird",
    ]);
  });

  it("collects Slack messages in same thread and preserves string thread id", async () => {
    const key = `test-collect-slack-thread-same-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
  });

  it("collects messages when numeric and string thread ids share the route key", async () => {
    const key = `test-collect-thread-normalized-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: 42.9,
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: "42",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.prompt).toContain("one");
    expect(calls[0]?.prompt).toContain("two");
  });

  it("does not collect Slack messages when thread ids differ", async () => {
    const key = `test-collect-slack-thread-diff-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000002",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
    expect(calls[1]?.originatingThreadId).toBe("1706000000.000002");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const key = `test-collect-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "two" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("retries only the remaining collect auth groups after a partial failure", async () => {
    const key = `test-collect-partial-retry-${Date.now()}`;
    const attempts: FollowupRun[] = [];
    const successfulCalls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      attempts.push(run);
      if (attempt === 2) {
        throw new Error("transient failure");
      }
      successfulCalls.push(run);
      if (attempt >= 3) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 50,
      dropPolicy: "summarize",
    };

    const guest = createRun({
      prompt: "guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const owner = createRun({
      prompt: "owner message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...guest,
        run: {
          ...guest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const guestAttempts = attempts.filter((call) => call.prompt.includes("guest message"));
    const ownerAttempts = attempts.filter((call) => call.prompt.includes("owner message"));

    expect(attempts).toHaveLength(3);
    expect(guestAttempts).toHaveLength(1);
    expect(ownerAttempts).toHaveLength(2);
    expect(successfulCalls.map((call) => call.prompt)).toEqual([
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from Guest)\nguest message",
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from Owner)\nowner message",
    ]);
  });

  it("retries overflow summary delivery without losing dropped previews", async () => {
    const key = `test-overflow-summary-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
  });

  it("includes the overflow summary only in the first split auth group", async () => {
    const key = `test-collect-overflow-summary-once-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const expectedCalls = 2;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= expectedCalls) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 2,
      dropPolicy: "summarize",
    };

    const droppedGuest = createRun({
      prompt: "dropped guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const guest = createRun({
      prompt: "guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const owner = createRun({
      prompt: "owner message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...droppedGuest,
        run: {
          ...droppedGuest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...guest,
        run: {
          ...guest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- dropped guest message");
    expect(calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(calls[1]?.prompt).not.toContain("dropped guest message");
  });

  it("does not re-deliver overflow summary on partial auth group failure retry", async () => {
    const key = `test-collect-overflow-partial-retry-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      // First group succeeds (attempt 1), second group fails (attempt 2),
      // then second group succeeds on retry (attempt 3).
      if (attempt === 2) {
        throw new Error("transient failure");
      }
      calls.push(run);
      if (calls.length >= 2) {
        done.resolve();
      }
    };
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 2,
      dropPolicy: "summarize",
    };

    const droppedGuest = createRun({
      prompt: "dropped guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const guest = createRun({
      prompt: "guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const owner = createRun({
      prompt: "owner message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...droppedGuest,
        run: {
          ...droppedGuest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...guest,
        run: {
          ...guest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(2);
    // First group got the overflow summary
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- dropped guest message");
    // Second group (retried after failure) must NOT get the overflow summary again
    expect(calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(calls[1]?.prompt).not.toContain("dropped guest message");
    expect(calls[1]?.prompt).toContain("owner message");
  });

  it("preserves routing metadata on overflow summary followups", async () => {
    const key = `test-overflow-summary-routing-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const done = createDeferred<void>();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };

    enqueueFollowupRun(
      key,
      createRun({
        prompt: "first",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );
    enqueueFollowupRun(
      key,
      createRun({
        prompt: "second",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      }),
      settings,
    );

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.originatingChannel).toBe("discord");
    expect(calls[0]?.originatingTo).toBe("channel:C1");
    expect(calls[0]?.originatingAccountId).toBe("work");
    expect(calls[0]?.originatingThreadId).toBe("1739142736.000100");
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });
});

describe("resolveFollowupAuthorizationKey", () => {
  it("changes when sender ownership changes", () => {
    const run = createRun({ prompt: "one" }).run;
    expect(
      resolveFollowupAuthorizationKey({
        ...run,
        senderId: "user-1",
        senderIsOwner: false,
      }),
    ).not.toBe(
      resolveFollowupAuthorizationKey({
        ...run,
        senderId: "user-1",
        senderIsOwner: true,
      }),
    );
  });

  it("changes when exec defaults change", () => {
    const run = createRun({ prompt: "one" }).run;
    expect(
      resolveFollowupAuthorizationKey({
        ...run,
        senderId: "user-1",
        bashElevated: { enabled: false, allowed: true, defaultLevel: "off" },
      }),
    ).not.toBe(
      resolveFollowupAuthorizationKey({
        ...run,
        senderId: "user-1",
        bashElevated: { enabled: true, allowed: true, defaultLevel: "on" },
        execOverrides: { ask: "always" },
      }),
    );
  });

  it("does not change when only sender display fields change", () => {
    const run = createRun({ prompt: "one" }).run;
    expect(
      resolveFollowupAuthorizationKey({
        ...run,
        senderId: "user-1",
        senderName: "Guest",
        senderUsername: "guest",
        senderIsOwner: false,
      }),
    ).toBe(
      resolveFollowupAuthorizationKey({
        ...run,
        senderId: "user-1",
        senderName: "Guest User",
        senderUsername: "guest-renamed",
        senderIsOwner: false,
      }),
    );
  });
});
