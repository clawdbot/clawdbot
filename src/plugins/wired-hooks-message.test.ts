/**
 * Test: message_sending & message_sent hook wiring
 *
 * Tests the hook runner methods directly since outbound delivery is deeply integrated.
 */
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import type {
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookHandlerMap,
} from "./types.js";

type PluginHookMessageSentEvent = Parameters<PluginHookHandlerMap["message_sent"]>[0];

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
      const firstStarted = createDeferred();
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

  it("fails closed when an enforcement handler throws", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const second = vi.fn().mockResolvedValue({ content: "must not send" });
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "message_sending",
          handler: vi.fn().mockRejectedValue(new Error("policy unavailable")),
          failurePolicy: "fail-closed",
        },
        { hookName: "message_sending", handler: second },
      ],
      { logger },
    );

    await expect(
      runner.runMessageSending({ to: "user-123", content: "original content" }, demoChannelCtx),
    ).resolves.toEqual({
      cancel: true,
      cancelReason: "message_sending_hook_failed_closed",
      metadata: { pluginId: "test-plugin" },
    });
    expect(second).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "[hooks] message_sending handler from test-plugin failed closed: policy unavailable",
    );
  });

  it("propagates ordinary handler errors when catching is disabled", async () => {
    const { runner } = createHookRunnerWithRegistry(
      [
        {
          hookName: "message_sending",
          handler: vi.fn().mockRejectedValue(new Error("handler failed")),
        },
      ],
      { catchErrors: false },
    );

    await expect(
      runner.runMessageSending({ to: "user-123", content: "original content" }, demoChannelCtx),
    ).rejects.toThrow("handler failed");
  });

  it("fails closed after an enforcement handler timeout", async () => {
    vi.useFakeTimers();
    try {
      const firstStarted = createDeferred();
      const { runner } = createHookRunnerWithRegistry([
        {
          hookName: "message_sending",
          handler: vi.fn(() => {
            firstStarted.resolve();
            return new Promise<PluginHookMessageSendingResult>(() => {});
          }),
          failurePolicy: "fail-closed",
        },
      ]);

      const resultPromise = runner.runMessageSending(
        { to: "user-123", content: "original content" },
        demoChannelCtx,
      );
      await firstStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(resultPromise).resolves.toEqual({
        cancel: true,
        cancelReason: "message_sending_hook_failed_closed",
        metadata: { pluginId: "test-plugin" },
      });
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
