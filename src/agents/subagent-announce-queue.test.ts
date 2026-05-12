import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AnnounceQueueItem,
  enqueueAnnounce,
  resetAnnounceQueuesForTests,
} from "./subagent-announce-queue.js";

function createRetryingSend() {
  const prompts: string[] = [];
  let attempts = 0;
  let resolved = false;
  let resolveSecondAttempt = () => {};
  const waitForSecondAttempt = new Promise<void>((resolve) => {
    resolveSecondAttempt = resolve;
  });

  const send = vi.fn(async (item: { prompt: string }) => {
    attempts += 1;
    prompts.push(item.prompt);
    if (attempts >= 2 && !resolved) {
      resolved = true;
      resolveSecondAttempt();
    }
    if (attempts === 1) {
      throw new Error("gateway timeout after 60000ms");
    }
  });

  return { send, prompts, waitForSecondAttempt };
}

function createCollectSendRecorder() {
  const calls: AnnounceQueueItem[] = [];
  const send = vi.fn(async (item: AnnounceQueueItem) => {
    calls.push(item);
  });
  return { calls, send };
}

describe("subagent-announce-queue", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAnnounceQueuesForTests();
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("[Queue overflow]");
    expect(sender.prompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("Queued #1");
    expect(sender.prompts[0]).toContain("queued item one");
    expect(sender.prompts[0]).toContain("Queued #2");
    expect(sender.prompts[0]).toContain("queued item two");
    expect(sender.prompts[1]).toContain("Queued #1");
    expect(sender.prompts[1]).toContain("queued item one");
    expect(sender.prompts[1]).toContain("Queued #2");
    expect(sender.prompts[1]).toContain("queued item two");
  });

  it("splits collect-mode batches when target authorization context changes", async () => {
    const sender = createCollectSendRecorder();
    const settings = { mode: "collect", debounceMs: 0 } as const;
    const origin = { channel: "slack", to: "channel:C123", accountId: "acct-1" };

    enqueueAnnounce({
      key: "announce:test:collect-auth-split",
      item: {
        prompt: "first child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:slack:thread:a",
        origin,
      },
      settings,
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-auth-split",
      item: {
        prompt: "second child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:slack:thread:b",
        origin,
      },
      settings,
      send: sender.send,
    });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledTimes(2);
    });
    expect(sender.calls.map((call) => call.sessionKey)).toEqual([
      "agent:main:slack:thread:a",
      "agent:main:slack:thread:b",
    ]);
    expect(sender.calls[0]?.prompt).toContain("first child completed");
    expect(sender.calls[0]?.prompt).not.toContain("second child completed");
    expect(sender.calls[1]?.prompt).toContain("second child completed");
  });

  it("keeps one collect-mode batch when target authorization context matches", async () => {
    const sender = createCollectSendRecorder();
    const settings = { mode: "collect", debounceMs: 0 } as const;
    const origin = { channel: "slack", to: "channel:C123", accountId: "acct-1" };

    enqueueAnnounce({
      key: "announce:test:collect-auth-match",
      item: {
        prompt: "first child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:slack:thread:a",
        origin,
      },
      settings,
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-auth-match",
      item: {
        prompt: "second child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:slack:thread:a",
        origin,
      },
      settings,
      send: sender.send,
    });

    await vi.waitFor(() => {
      expect(sender.send).toHaveBeenCalledTimes(1);
    });
    expect(sender.calls[0]?.sessionKey).toBe("agent:main:slack:thread:a");
    expect(sender.calls[0]?.prompt).toContain("first child completed");
    expect(sender.calls[0]?.prompt).toContain("second child completed");
  });

  it("waits until a busy parent session becomes idle before draining", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    let parentBusy = true;
    const send = vi.fn(async (_item: AnnounceQueueItem) => {});

    enqueueAnnounce({
      key: "announce:test:busy-parent",
      item: {
        prompt: "child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
      shouldDefer: () => parentBusy,
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(send).not.toHaveBeenCalled();

    parentBusy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.at(0)?.[0]?.prompt).toBe("child completed");
  });

  it("preserves an existing defer hook when the same queue is reused without one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    let parentBusy = true;
    const send = vi.fn(async (_item: AnnounceQueueItem) => {});

    enqueueAnnounce({
      key: "announce:test:reuse-keeps-defer",
      item: {
        prompt: "first child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
      shouldDefer: () => parentBusy,
    });

    enqueueAnnounce({
      key: "announce:test:reuse-keeps-defer",
      item: {
        prompt: "second child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(send).not.toHaveBeenCalled();

    parentBusy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("polls deferred items at the configured cadence after the first debounce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    let parentBusy = true;
    const send = vi.fn(async (_item: AnnounceQueueItem) => {});

    enqueueAnnounce({
      key: "announce:test:defer-cadence",
      item: {
        prompt: "child completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 1_000 },
      send,
      shouldDefer: () => parentBusy,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).not.toHaveBeenCalled();

    parentBusy = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back to delivery when busy-parent deferral exceeds the safety cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const send = vi.fn(async (_item: AnnounceQueueItem) => {});

    enqueueAnnounce({
      key: "announce:test:busy-parent-timeout",
      item: {
        prompt: "child completed after stale busy state",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send,
      shouldDefer: () => true,
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.at(0)?.[0]?.prompt).toBe("child completed after stale busy state");
  });

  it("uses debounce floor for retries when debounce exceeds backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;

    try {
      const attempts: number[] = [];
      const send = vi.fn(async () => {
        attempts.push(Date.now());
        if (attempts.length === 1) {
          throw new Error("transient timeout");
        }
      });

      enqueueAnnounce({
        key: "announce:test:retry-debounce-floor",
        item: {
          prompt: "subagent completed",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:telegram:dm:u1",
        },
        settings: { mode: "followup", debounceMs: 5_000 },
        send,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      const [firstAttempt, secondAttempt] = attempts;
      if (firstAttempt === undefined || secondAttempt === undefined) {
        throw new Error("expected two retry attempts");
      }
      expect(secondAttempt - firstAttempt).toBeGreaterThanOrEqual(5_000);
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });
});
