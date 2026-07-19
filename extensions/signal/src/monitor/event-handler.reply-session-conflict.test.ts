// Signal tests cover retry behavior for reply session initialization conflicts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { dispatchReplyWithBufferedBlockDispatcher } from "../../../../src/auto-reply/reply/provider-dispatcher.js";

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
  sendReactionSignalMock: vi.fn(
    async (_recipient: string, _targetTimestamp: number, _emoji: string, _opts: unknown) => ({
      ok: true,
    }),
  ),
  removeReactionSignalMock: vi.fn(async () => ({ ok: true })),
  dispatchInboundMessageMock: vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(),
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

vi.mock("../../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: dispatchInboundMessageMock,
}));

vi.mock("../../../../src/channels/session.js", () => ({
  recordInboundSession: recordInboundSessionMock,
}));

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
        cfg: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "direct",
            inbound: { debounceMs: 10 },
            statusReactions: {
              enabled: true,
              timing: {
                debounceMs: 0,
                doneHoldMs: 0,
                errorHoldMs: 0,
                stallSoftMs: 60_000,
                stallHardMs: 120_000,
              },
            },
          },
        },
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
      expect(sendReactionSignalMock.mock.calls.map((call) => call[2])).not.toContain("❌");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry when the Signal monitor aborts", async () => {
    dispatchInboundMessageMock.mockRejectedValueOnce(CONFLICT_ERROR);
    const abort = new AbortController();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "direct",
            inbound: { debounceMs: 10 },
            statusReactions: {
              enabled: true,
              emojis: {
                queued: "⏳",
                thinking: "🤔",
                tool: "🔧",
                done: "✅",
                error: "❌",
              },
              timing: {
                debounceMs: 0,
                doneHoldMs: 0,
                errorHoldMs: 0,
                stallSoftMs: 60_000,
                stallHardMs: 120_000,
              },
            },
          },
        },
        abortSignal: abort.signal,
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

      abort.abort(new Error("monitor stopped"));
      await vi.advanceTimersByTimeAsync(0);
      const reactionsAfterAbortCleanup = sendReactionSignalMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(130_000);

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(sendReactionSignalMock).toHaveBeenCalledTimes(reactionsAfterAbortCleanup);
      expect(sendReactionSignalMock.mock.calls.map((call) => call[2])).not.toContain("❌");
      expect(sendReactionSignalMock.mock.calls.at(-1)?.[2]).toBe("👀");
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons merged siblings when any durable claim is reclaimed", async () => {
    dispatchInboundMessageMock.mockRejectedValueOnce(CONFLICT_ERROR);
    const firstClaimAbort = new AbortController();
    const secondClaimAbort = new AbortController();
    const trackedTasks: Promise<void>[] = [];
    const errorLogs: string[] = [];
    const baseRuntime = createBaseSignalEventHandlerDeps().runtime;
    const firstOnAbandoned = vi.fn();
    const secondOnAbandoned = vi.fn();
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
        runTrackedTask: (task) => {
          trackedTasks.push(task());
        },
        runtime: {
          ...baseRuntime,
          error: (...args: unknown[]) => {
            errorLogs.push(String(args[0]));
          },
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const firstHandled = handler(
        createSignalReceiveEvent({
          dataMessage: { message: "first claimed part", attachments: [] },
        }),
        {
          abortSignal: firstClaimAbort.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: firstOnAbandoned,
        },
      );
      const secondHandled = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000002,
          dataMessage: { message: "second claimed part", attachments: [] },
        }),
        {
          abortSignal: secondClaimAbort.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: secondOnAbandoned,
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(Promise.all([firstHandled, secondHandled])).resolves.toEqual([
        { kind: "deferred" },
        { kind: "deferred" },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      secondClaimAbort.abort(new Error("claim reclaimed"));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(trackedTasks);

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(firstOnAbandoned).toHaveBeenCalledOnce();
      expect(secondOnAbandoned).not.toHaveBeenCalled();
      expect(errorLogs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the keyed debounce lane reserved until a retry settles", async () => {
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
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
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

      const newer = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000002,
          dataMessage: { message: "wait behind the retry", attachments: [] },
        }),
      );
      await newer;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      resolveRetry?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the configured number of retry attempts", async () => {
    dispatchInboundMessageMock.mockRejectedValue(CONFLICT_ERROR);

    const errorLogs: string[] = [];
    const trackedTasks: Promise<void>[] = [];
    let resolveFirstAbandonment: (() => void) | undefined;
    let resolveSecondAbandonment: (() => void) | undefined;
    const firstOnAbandoned = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstAbandonment = resolve;
        }),
    );
    const secondOnAbandoned = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSecondAbandonment = resolve;
        }),
    );
    const firstLifecycleAbort = new AbortController();
    const secondLifecycleAbort = new AbortController();
    let trackedTaskSettled = false;
    const baseRuntime = createBaseSignalEventHandlerDeps().runtime;
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 10 } } },
        runTrackedTask: (task) => {
          trackedTasks.push(
            task().then(() => {
              trackedTaskSettled = true;
            }),
          );
        },
        runtime: {
          ...baseRuntime,
          error: (...args: unknown[]) => {
            errorLogs.push(String(args[0]));
          },
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const firstHandled = handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "first claimed part",
            attachments: [],
          },
        }),
        {
          abortSignal: firstLifecycleAbort.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: firstOnAbandoned,
        },
      );
      const secondHandled = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000002,
          dataMessage: {
            message: "second claimed part",
            attachments: [],
          },
        }),
        {
          abortSignal: secondLifecycleAbort.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAdoptionFinalizing: vi.fn(),
          onAbandoned: secondOnAbandoned,
        },
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(Promise.all([firstHandled, secondHandled])).resolves.toEqual([
        { kind: "deferred" },
        { kind: "deferred" },
      ]);

      // Initial attempt.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(trackedTasks).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

      // No further retries should be scheduled; advancing again does nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);
      expect(firstOnAbandoned).toHaveBeenCalledTimes(1);
      expect(secondOnAbandoned).toHaveBeenCalledTimes(1);
      expect(trackedTaskSettled).toBe(false);
      resolveFirstAbandonment?.();
      resolveSecondAbandonment?.();
      await Promise.all(trackedTasks);

      expect(errorLogs.some((msg) => msg.includes("signal debounce flush failed"))).toBe(true);
      expect(trackedTaskSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-progress terminal status hold and restores the acknowledgement", async () => {
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const abort = new AbortController();
    const trackedTasks: Promise<void>[] = [];
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "direct",
            removeAckAfterReply: true,
            inbound: { debounceMs: 10 },
            statusReactions: {
              enabled: true,
              timing: {
                debounceMs: 0,
                doneHoldMs: 60_000,
                errorHoldMs: 60_000,
                stallSoftMs: 120_000,
                stallHardMs: 180_000,
              },
            },
          },
        },
        abortSignal: abort.signal,
        runTrackedTask: (task) => {
          trackedTasks.push(task());
        },
      }),
    );

    vi.useFakeTimers();
    try {
      const handled = handler(
        createSignalReceiveEvent({
          dataMessage: { message: "finish before shutdown", attachments: [] },
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(handled).resolves.toBeUndefined();
      expect(sendReactionSignalMock.mock.calls.map((call) => call[2])).toContain("✅");

      abort.abort(new Error("monitor stopped during status hold"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(trackedTasks);

      expect(sendReactionSignalMock.mock.calls.at(-1)?.[2]).toBe("👀");
      const reactionCount = sendReactionSignalMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sendReactionSignalMock).toHaveBeenCalledTimes(reactionCount);
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
        },
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
