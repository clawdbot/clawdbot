import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Signal tests cover retry behavior for reply session initialization conflicts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

const {
  sendTypingMock,
  sendReadReceiptMock,
  sendReactionSignalMock,
  removeReactionSignalMock,
  dispatchInboundMessageMock,
  recordInboundSessionMock,
} = vi.hoisted(() => ({
  sendTypingMock: vi.fn(),
  sendReadReceiptMock: vi.fn(),
  sendReactionSignalMock: vi.fn(async () => ({ ok: true })),
  removeReactionSignalMock: vi.fn(async () => ({ ok: true })),
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: <T>(delayMs: number, value?: T, options?: { signal?: AbortSignal }) =>
    new Promise<T | undefined>((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        return;
      }
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const timer = globalThis.setTimeout(() => {
        cleanup();
        resolve(value);
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: sendReactionSignalMock,
  removeReactionSignal: removeReactionSignalMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    recordInboundSession: recordInboundSessionMock,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
});

const CONFLICT_ERROR = new Error(
  "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
);

function createTrackedTaskHarness() {
  const tasks: Promise<void>[] = [];
  return {
    tasks,
    runTrackedTask: (task: () => Promise<void>) => {
      tasks.push(task());
    },
  };
}

describe("signal reply session init conflict retry", () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    sendReactionSignalMock.mockReset().mockResolvedValue({ ok: true });
    removeReactionSignalMock.mockReset().mockResolvedValue({ ok: true });
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    dispatchInboundMessageMock.mockReset();
  });

  it("retries a debounced flush that fails with a reply session init conflict", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(
        new Error("dispatch wrapper failed", {
          cause: { error: CONFLICT_ERROR },
        }),
      )
      .mockResolvedValueOnce({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
      }),
    );

    vi.useFakeTimers();
    try {
      const handled = handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello after prior turn",
            attachments: [],
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await handled;

      // Initial flush fails and enters the retry backoff.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      // The same failed batch is dispatched again.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry when the Signal monitor aborts", async () => {
    dispatchInboundMessageMock.mockRejectedValueOnce(CONFLICT_ERROR);
    const abort = new AbortController();
    const tracked = createTrackedTaskHarness();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
        abortSignal: abort.signal,
        runTrackedTask: tracked.runTrackedTask,
      }),
    );

    vi.useFakeTimers();
    try {
      const handled = handler(
        createSignalReceiveEvent({
          dataMessage: { message: "do not dispatch after shutdown", attachments: [] },
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await handled;

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(tracked.tasks).toHaveLength(1);

      abort.abort(new Error("monitor stopped"));
      await Promise.all(tracked.tasks);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(tracked.tasks).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a retry that crossed the timer boundary in the monitor task runner", async () => {
    let resolveRetry: (() => void) | undefined;
    const retryDispatch = new Promise<{ queuedFinal: boolean; counts: Record<string, number> }>(
      (resolve) => {
        resolveRetry = () =>
          resolve({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });
      },
    );
    dispatchInboundMessageMock
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockReturnValueOnce(retryDispatch);
    const tracked = createTrackedTaskHarness();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
        runTrackedTask: tracked.runTrackedTask,
      }),
    );

    vi.useFakeTimers();
    try {
      const handled = handler(
        createSignalReceiveEvent({
          dataMessage: { message: "wait for this retry", attachments: [] },
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await handled;
      expect(tracked.tasks).toHaveLength(1);

      let trackedTaskSettled = false;
      void tracked.tasks[0]?.then(() => {
        trackedTaskSettled = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(tracked.tasks).toHaveLength(1);
      expect(trackedTaskSettled).toBe(false);

      resolveRetry?.();
      await tracked.tasks[0];
      expect(trackedTaskSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the configured number of retry attempts", async () => {
    dispatchInboundMessageMock.mockRejectedValue(CONFLICT_ERROR);

    const errorLogs: string[] = [];
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
        runtime: {
          log: () => {},
          error: (msg: string) => {
            errorLogs.push(msg);
          },
        } as SignalEventHandlerDeps["runtime"],
      }),
    );

    vi.useFakeTimers();
    try {
      const handled = handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello after prior turn",
            attachments: [],
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await handled;

      // Initial attempt.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

      // No further retries should be scheduled; advancing again does nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

      expect(errorLogs.some((msg) => msg.includes("signal debounce flush failed"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-conflict flush failures", async () => {
    dispatchInboundMessageMock.mockRejectedValue(new Error("some other dispatch failure"));

    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());

    vi.useFakeTimers();
    try {
      await handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello",
            attachments: [],
          },
        }),
      );

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed batch as one ordered dispatch", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValueOnce({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 10 } },
        } as OpenClawConfig,
      }),
    );

    vi.useFakeTimers();
    try {
      const first = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000001,
          dataMessage: { message: "first", attachments: [] },
        }),
      );
      const second = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000002,
          dataMessage: { message: "second", attachments: [] },
        }),
      );

      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([first, second]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      const retryCall = dispatchInboundMessageMock.mock.calls[1]?.[0] as
        | { ctx?: { Body?: string } }
        | undefined;
      const body = retryCall?.ctx?.Body ?? "";
      expect(body).toContain("first");
      expect(body).toContain("second");
      expect(body.indexOf("first")).toBeLessThan(body.indexOf("second"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps newer buffered messages behind the failed batch during backoff", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValue({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
      }),
    );

    vi.useFakeTimers();
    try {
      const older = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000001,
          dataMessage: { message: "older failed message", attachments: [] },
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await older;
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      const newer = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000002,
          dataMessage: { message: "newer buffered message", attachments: [] },
        }),
      );
      await newer;
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(990);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);
      const dispatchedBodies = dispatchInboundMessageMock.mock.calls.map((call) => {
        const payload = call[0] as { ctx?: { Body?: string } };
        return payload.ctx?.Body ?? "";
      });
      expect(dispatchedBodies[1]).toContain("older failed message");
      expect(dispatchedBodies[1]).not.toContain("newer buffered message");
      expect(dispatchedBodies[2]).toContain("newer buffered message");
    } finally {
      vi.useRealTimers();
    }
  });
});
