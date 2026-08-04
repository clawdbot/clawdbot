import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeVoiceAudioQueue,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceSessionConnection,
} from "./realtime-voice.js";

function connectLifecycle(
  lifecycle: RealtimeVoiceSessionLifecycle,
): RealtimeVoiceSessionConnection {
  let connection: RealtimeVoiceSessionConnection | undefined;
  void lifecycle.connect(async (current) => {
    connection = current;
  });
  if (!connection) {
    throw new Error("expected synchronous connection ownership");
  }
  return connection;
}

describe("RealtimeVoiceSessionLifecycle", () => {
  it("terminalizes preconnect cancellation until an explicit fresh connection", () => {
    const lifecycle = new RealtimeVoiceSessionLifecycle("Test");

    expect(lifecycle.phase()).toBe("idle");
    expect(lifecycle.isReady()).toBe(false);
    expect(lifecycle.cancel()).toBe(true);
    expect(lifecycle.phase()).toBe("terminal");
    expect(lifecycle.cancel()).toBe(false);

    const connection = connectLifecycle(lifecycle);
    expect(lifecycle.phase()).toBe("connecting");
    expect(lifecycle.ready(connection)).toBe(true);
    expect(lifecycle.phase()).toBe("ready");
  });

  it("owns retry attempts and resets them only after provider readiness", () => {
    const lifecycle = new RealtimeVoiceSessionLifecycle("Test");
    const first = connectLifecycle(lifecycle);

    expect(lifecycle.retry(first, 2)).toMatchObject({ attempt: 1 });
    expect(lifecycle.acceptsEvents(first)).toBe(false);
    expect(lifecycle.retry(first, 2)).toBeUndefined();
    const second = lifecycle.reconnect(first);
    expect(second).toBeDefined();
    if (!second) {
      throw new Error("expected a retry connection");
    }

    expect(lifecycle.retry(second, 2)).toMatchObject({ attempt: 2 });
    const third = lifecycle.reconnect(second);
    expect(third).toBeDefined();
    if (!third) {
      throw new Error("expected a second retry connection");
    }
    expect(lifecycle.retry(third, 2)).toBe("exhausted");

    expect(lifecycle.ready(third)).toBe(true);
    expect(lifecycle.retry(third, 2)).toMatchObject({ attempt: 1 });
  });

  it("ignores stale connections and aborts explicit replacements", async () => {
    const lifecycle = new RealtimeVoiceSessionLifecycle("Test");
    const first = connectLifecycle(lifecycle);
    lifecycle.retry(first, 1);
    const retry = lifecycle.reconnect(first);
    expect(retry).toBeDefined();
    if (!retry) {
      throw new Error("expected a retry connection");
    }

    expect(lifecycle.ready(first)).toBe(false);
    expect(lifecycle.close(first, "error")).toBeUndefined();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.ready(retry)).toBe(true);

    expect(lifecycle.retry(retry, 1)).toMatchObject({ attempt: 1 });
    await Promise.resolve();
    const replacement = connectLifecycle(lifecycle);
    expect(retry.signal.aborted).toBe(true);
    expect(retry.signal.reason).toEqual(new Error("Test realtime voice connection replaced"));
    expect(lifecycle.failure(retry)).toBe(false);
    expect(lifecycle.ready(replacement)).toBe(true);
  });

  it("keeps terminal outcomes authoritative and notifies once", () => {
    const canceled = new RealtimeVoiceSessionLifecycle("Test");
    const canceledConnection = connectLifecycle(canceled);

    expect(canceled.cancel()).toBe(true);
    expect(canceledConnection.signal.aborted).toBe(true);
    expect(canceled.acceptsEvents(canceledConnection)).toBe(false);
    expect(canceled.cancel()).toBe(false);
    expect(canceled.failure(canceledConnection)).toBe(false);
    expect(canceled.terminalOutcome(canceledConnection)).toBe("completed");
    expect(canceled.close(canceledConnection, "error")).toBe("completed");
    expect(canceled.close(canceledConnection, "completed")).toBeUndefined();

    const failed = new RealtimeVoiceSessionLifecycle("Test");
    const failedConnection = connectLifecycle(failed);
    expect(failed.failure(failedConnection)).toBe(true);
    expect(failed.cancel()).toBe(false);
    expect(failed.close(failedConnection, "completed")).toBe("error");
    expect(failed.close(failedConnection, "error")).toBeUndefined();
  });

  it("coalesces connects and lets cancellation immediately transfer ownership", async () => {
    const lifecycle = new RealtimeVoiceSessionLifecycle("Test");
    const firstStarted = vi.fn();
    const secondStarted = vi.fn();
    let firstConnection: RealtimeVoiceSessionConnection | undefined;

    const first = lifecycle.connect(
      (connection) =>
        new Promise<void>((_resolve, reject) => {
          firstConnection = connection;
          firstStarted();
          connection.signal.addEventListener(
            "abort",
            () => {
              const reason = connection.signal.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason)));
            },
            { once: true },
          );
        }),
    );
    const coalesced = lifecycle.connect(async () => {
      secondStarted();
    });

    expect(coalesced).toBe(first);
    expect(firstStarted).toHaveBeenCalledOnce();
    expect(secondStarted).not.toHaveBeenCalled();
    expect(lifecycle.cancel()).toBe(true);

    const replacement = lifecycle.connect(async (connection) => {
      expect(connection).not.toBe(firstConnection);
      secondStarted();
    });
    await replacement;
    await expect(first).rejects.toThrow("Test realtime voice session canceled");
    expect(secondStarted).toHaveBeenCalledOnce();
  });

  it("exposes cancellation to async setup before it can create a late transport", async () => {
    const lifecycle = new RealtimeVoiceSessionLifecycle("Test");
    let resolveCredentials = () => {};
    const credentials = new Promise<void>((resolve) => {
      resolveCredentials = resolve;
    });
    const openTransport = vi.fn();

    const connecting = lifecycle.connect(async (connection) => {
      await credentials;
      if (!connection.signal.aborted) {
        openTransport();
      }
    });
    lifecycle.cancel();
    resolveCredentials();
    await connecting;

    expect(openTransport).not.toHaveBeenCalled();
  });

  it("starts connect timeouts explicitly and releases timeout and abort ownership", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = new RealtimeVoiceSessionLifecycle("Test");
      const connection = connectLifecycle(lifecycle);
      const onAbort = vi.fn();
      const onTimeout = vi.fn();
      const attempt = lifecycle.createConnectAttempt({
        connection,
        onAbort,
        onTimeout,
        timeoutError: () => new Error("timed out"),
        timeoutMs: 10,
      });

      attempt.startTimeout();
      attempt.resolve(true);
      attempt.reject(new Error("late failure"));
      await expect(attempt.promise).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(10);
      lifecycle.cancel();

      expect(attempt.ready).toBe(true);
      expect(attempt.settled).toBe(true);
      expect(onTimeout).not.toHaveBeenCalled();
      expect(onAbort).not.toHaveBeenCalled();

      const timeoutLifecycle = new RealtimeVoiceSessionLifecycle("Test");
      const timeoutConnection = connectLifecycle(timeoutLifecycle);
      const timeoutAttempt = timeoutLifecycle.createConnectAttempt({
        connection: timeoutConnection,
        onAbort: vi.fn(),
        onTimeout,
        timeoutError: () => new Error("timed out"),
        timeoutMs: 10,
      });
      const rejected = expect(timeoutAttempt.promise).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10);
      expect(onTimeout).not.toHaveBeenCalled();

      timeoutAttempt.startTimeout();
      timeoutAttempt.startTimeout();
      await vi.advanceTimersByTimeAsync(10);
      await rejected;

      expect(timeoutAttempt.startupFailed).toBe(true);
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns copied pending audio and clears it at terminal boundaries", () => {
    const lifecycle = new RealtimeVoiceSessionLifecycle("Test");
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x01);
    const view = backing.subarray(0, 512 * 1024);

    expect(lifecycle.enqueuePendingAudio(view)).toBe(true);
    view.fill(0);
    expect(lifecycle.enqueuePendingAudio(Buffer.alloc(512 * 1024, 0x02))).toBe(true);
    expect(lifecycle.enqueuePendingAudio(Buffer.from([0x03]))).toBe(false);
    expect(lifecycle.drainPendingAudio()).toEqual([
      Buffer.alloc(512 * 1024, 0x01),
      Buffer.alloc(512 * 1024, 0x02),
    ]);

    lifecycle.enqueuePendingAudio(Buffer.from([0x04]));
    lifecycle.cancel();
    expect(lifecycle.drainPendingAudio()).toEqual([]);
  });
});

describe("createRealtimeVoiceAudioQueue", () => {
  it("drops the oldest audio and resets accounting on clear", () => {
    const queue = createRealtimeVoiceAudioQueue("drop-oldest");
    for (let index = 0; index < 322; index += 1) {
      expect(queue.enqueue(Buffer.from([index & 0xff]))).toBe(true);
    }

    const drained = queue.drain();
    expect(drained).toHaveLength(320);
    expect(drained[0]).toEqual(Buffer.from([2]));
    expect(drained.at(-1)).toEqual(Buffer.from([65]));

    expect(queue.enqueue(Buffer.alloc(1024 * 1024, 0x04))).toBe(true);
    queue.clear();
    expect(queue.enqueue(Buffer.from([0x05]))).toBe(true);
    expect(queue.drain()).toEqual([Buffer.from([0x05])]);
  });
});
