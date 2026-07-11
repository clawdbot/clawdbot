/**
 * Test: message_sending & message_sent hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";
import type {
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
} from "./types.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function expectMessageHookCall(params: {
  hookName: "message_sending" | "message_sent";
  event: PluginHookMessageSendingEvent | PluginHookMessageSentEvent;
  hookResult?: PluginHookMessageSendingResult;
  expectedResult?: PluginHookMessageSendingResult;
  channelCtx: { channelId: string };
}) {
  const handler =
    params.hookResult === undefined ? vi.fn() : vi.fn().mockReturnValue(params.hookResult);
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "message_sending") {
    const result = await runner.runMessageSending(
      params.event as PluginHookMessageSendingEvent,
      params.channelCtx,
    );
    if (params.expectedResult === undefined) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toEqual(params.expectedResult);
    }
  } else {
    await runner.runMessageSent(params.event as PluginHookMessageSentEvent, params.channelCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.channelCtx);
}

describe("message_sending hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };
  it.each([
    {
      name: "runMessageSending invokes registered hooks and returns modified content",
      event: { to: "user-123", content: "original content" },
      hookResult: { content: "modified content" },
      expected: { content: "modified content" },
    },
    {
      name: "runMessageSending can cancel message delivery",
      event: { to: "user-123", content: "blocked" },
      hookResult: { cancel: true, cancelReason: "policy", metadata: { owner: "agent-2" } },
      expected: { cancel: true, cancelReason: "policy", metadata: { owner: "agent-2" } },
    },
  ] as const)("$name", async ({ event, hookResult, expected }) => {
    await expectMessageHookCall({
      hookName: "message_sending",
      event,
      hookResult,
      expectedResult: expected,
      channelCtx: demoChannelCtx,
    });
  });

  it("fails open after the default per-handler timeout", async () => {
    vi.useFakeTimers();
    try {
      const logger = { warn: vi.fn(), error: vi.fn() };
      const firstStarted = createDeferred<void>();
      const first = vi.fn(() => {
        firstStarted.resolve();
        return new Promise<PluginHookMessageSendingResult>(() => {});
      });
      const second = vi.fn().mockResolvedValue({ content: "after timeout" });
      const { runner } = createHookRunnerWithRegistry(
        [
          { hookName: "message_sending", handler: first },
          { hookName: "message_sending", handler: second },
        ],
        { logger },
      );

      const resultPromise = runner.runMessageSending(
        { to: "user-123", content: "original content" },
        demoChannelCtx,
      );
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(resultPromise).resolves.toEqual({ content: "after timeout" });
      expect(second).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] message_sending handler from test-plugin failed: timed out after 15000ms",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a handler-specific timeout longer than the default", async () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn(
        () =>
          new Promise<PluginHookMessageSendingResult>((resolve) => {
            setTimeout(() => resolve({ content: "slow result" }), 16_000);
          }),
      );
      const { runner } = createHookRunnerWithRegistry([
        { hookName: "message_sending", handler, timeoutMs: 20_000 },
      ]);
      const resultPromise = runner.runMessageSending(
        { to: "user-123", content: "original content" },
        demoChannelCtx,
      );
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(resultPromise).resolves.toEqual({ content: "slow result" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("message_sent hook runner", () => {
  const demoChannelCtx = { channelId: "demo-channel" };

  it.each([
    {
      name: "runMessageSent invokes registered hooks with success=true",
      event: { to: "user-123", content: "hello", success: true },
    },
    {
      name: "runMessageSent invokes registered hooks with error on failure",
      event: { to: "user-123", content: "hello", success: false, error: "timeout" },
    },
  ] as const)("$name", async ({ event }) => {
    await expectMessageHookCall({
      hookName: "message_sent",
      event,
      channelCtx: demoChannelCtx,
    });
  });
});
