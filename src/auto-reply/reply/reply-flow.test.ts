// Tests high-level reply flow decisions across commands and agent dispatch.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  composeReplyDispatchBeforeDeliver,
  createReplyDispatcher,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

type DeliverPayload = Parameters<Parameters<typeof createReplyDispatcher>[0]["deliver"]>[0];
type DeliverMock = { mock: { calls: unknown[][] } };

function deliveredText(deliver: DeliverMock, index = 0) {
  const payload = deliver.mock.calls[index]?.[0] as DeliverPayload | undefined;
  return payload?.text;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createReplyDispatcher", () => {
  it("drops empty payloads and exact silent tokens without media", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    expect(dispatcher.sendFinalReply({})).toBe(false);
    expect(dispatcher.sendFinalReply({ text: " " })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: `${SILENT_REPLY_TOKEN} -- nope` })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: `interject.${SILENT_REPLY_TOKEN}` })).toBe(true);

    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliveredText(deliver)).toBe(`${SILENT_REPLY_TOKEN} -- nope`);
    expect(deliveredText(deliver, 1)).toBe(`interject.${SILENT_REPLY_TOKEN}`);
  });

  it("drops exact NO_REPLY final payloads for direct sessions", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
          },
        },
      },
    };
    const dispatcher = createReplyDispatcher({
      deliver,
      silentReplyContext: {
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      },
    });

    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);

    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("still drops exact NO_REPLY final payloads for group sessions where silence is allowed", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
          },
        },
      },
    };
    const dispatcher = createReplyDispatcher({
      deliver,
      silentReplyContext: {
        cfg,
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      },
    });

    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);

    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("strips heartbeat tokens and applies responsePrefix", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onHeartbeatStrip = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
      onHeartbeatStrip,
    });

    expect(dispatcher.sendFinalReply({ text: HEARTBEAT_TOKEN })).toBe(false);
    expect(dispatcher.sendToolResult({ text: `${HEARTBEAT_TOKEN} hello` })).toBe(true);
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliveredText(deliver)).toBe("PFX hello");
    expect(onHeartbeatStrip).toHaveBeenCalledTimes(2);
  });

  it("avoids double-prefixing and keeps media when heartbeat is the only text", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      responsePrefix: "PFX",
    });

    expect(
      dispatcher.sendFinalReply({
        text: "PFX already",
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: HEARTBEAT_TOKEN,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);
    expect(
      dispatcher.sendFinalReply({
        text: `${SILENT_REPLY_TOKEN} -- explanation`,
        mediaUrl: "file:///tmp/photo.jpg",
      }),
    ).toBe(true);

    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliveredText(deliver)).toBe("PFX already");
    expect(deliveredText(deliver, 1)).toBe("");
    expect(deliveredText(deliver, 2)).toBe(`PFX ${SILENT_REPLY_TOKEN} -- explanation`);
  });

  it("preserves ordering across tool, block, and final replies", async () => {
    const delivered: string[] = [];
    const deliver = vi.fn(async (_payload, info) => {
      delivered.push(info.kind);
      if (info.kind === "tool") {
        await Promise.resolve();
      }
    });
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendBlockReply({ text: "block" });
    dispatcher.sendFinalReply({ text: "final" });

    await dispatcher.waitForIdle();
    expect(delivered).toEqual(["tool", "block", "final"]);
  });

  it("releases the same dispatcher after a beforeDeliver timeout", async () => {
    vi.useFakeTimers();
    try {
      const hookStarted = createDeferred<void>();
      const delivered: string[] = [];
      const errors: string[] = [];
      let hookCalls = 0;
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
        beforeDeliver: (payload) => {
          hookCalls += 1;
          if (hookCalls === 1) {
            hookStarted.resolve();
            return new Promise<never>(() => {});
          }
          return payload;
        },
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });

      dispatcher.sendFinalReply({ text: "stuck final" });
      dispatcher.sendFinalReply({ text: "follow-up final" });
      dispatcher.markComplete();
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await dispatcher.waitForIdle();

      expect(delivered).toEqual(["follow-up final"]);
      expect(errors).toEqual(["beforeDeliver timed out after 15000ms"]);
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
      expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds hooks appended after dispatcher construction", async () => {
    vi.useFakeTimers();
    try {
      const hookStarted = createDeferred<void>();
      const delivered: string[] = [];
      let hookCalls = 0;
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
      });
      dispatcher.appendBeforeDeliver?.((payload) => {
        hookCalls += 1;
        if (hookCalls === 1) {
          hookStarted.resolve();
          return new Promise<never>(() => {});
        }
        return payload;
      });

      dispatcher.sendFinalReply({ text: "stuck final" });
      dispatcher.sendFinalReply({ text: "follow-up final" });
      dispatcher.markComplete();
      await hookStarted.promise;
      await vi.advanceTimersByTimeAsync(15_000);
      await dispatcher.waitForIdle();

      expect(delivered).toEqual(["follow-up final"]);
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
      expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-positive and non-finite beforeDeliver budgets", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createReplyDispatcher({
          deliver: async () => {},
          beforeDeliver: (payload) => payload,
          beforeDeliverOptions: { timeoutMs },
        }),
      ).toThrow("beforeDeliver timeoutMs must be a positive finite number");

      const dispatcher = createReplyDispatcher({ deliver: async () => {} });
      expect(() => dispatcher.appendBeforeDeliver?.((payload) => payload, { timeoutMs })).toThrow(
        "beforeDeliver timeoutMs must be a positive finite number",
      );
    }
  });

  it("honors owner-declared budgets for constructor and appended callbacks", async () => {
    vi.useFakeTimers();
    try {
      const delivered: string[] = [];
      const errors: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
        beforeDeliver: async (payload) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 16_000);
          });
          return { ...payload, text: `${payload.text}:constructor` };
        },
        beforeDeliverOptions: { timeoutMs: 20_000 },
        onError: (error) => {
          errors.push(error instanceof Error ? error.message : String(error));
        },
      });
      dispatcher.appendBeforeDeliver?.(
        async (payload) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 16_000);
          });
          return { ...payload, text: `${payload.text}:appended` };
        },
        { timeoutMs: 20_000 },
      );

      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(delivered).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(delivered).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      await dispatcher.waitForIdle();

      expect(delivered).toEqual(["final:constructor:appended"]);
      expect(errors).toEqual([]);
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a composed stage budget into a whole-chain deadline", async () => {
    vi.useFakeTimers();
    try {
      const delivered: string[] = [];
      const beforeDeliver = composeReplyDispatchBeforeDeliver(
        {
          hook: async (payload) => {
            await new Promise((resolve) => {
              setTimeout(resolve, 16_000);
            });
            return { ...payload, text: `${payload.text}:owner` };
          },
          options: { timeoutMs: 20_000 },
        },
        async (payload) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 10_000);
          });
          return { ...payload, text: `${payload.text}:plugin` };
        },
      );
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
        beforeDeliver,
        beforeDeliverOptions: { timeoutMs: 20_000 },
      });

      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(delivered).toEqual([]);
      await vi.advanceTimersByTimeAsync(6_000);
      await dispatcher.waitForIdle();

      expect(delivered).toEqual(["final:owner:plugin"]);
      expect(dispatcher.getFailedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each beforeDeliver hook its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          delivered.push(payload.text ?? "");
        },
        beforeDeliver: async (payload) => {
          await new Promise((resolve) => {
            setTimeout(resolve, 10_000);
          });
          return { ...payload, text: `${payload.text}:first` };
        },
      });
      dispatcher.appendBeforeDeliver?.(async (payload) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10_000);
        });
        return { ...payload, text: `${payload.text}:second` };
      });

      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(delivered).toEqual([]);
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
      await dispatcher.waitForIdle();

      expect(delivered).toEqual(["final:first:second"]);
      expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a hook appended after enqueue before the chain starts", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({ deliver });

    dispatcher.sendFinalReply({ text: "queued" });
    dispatcher.appendBeforeDeliver?.((payload) => ({ ...payload, text: "appended" }));
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredText(deliver)).toBe("appended");
  });

  it("fires onIdle when the queue drains", async () => {
    const deliver: Parameters<typeof createReplyDispatcher>[0]["deliver"] = async () =>
      await Promise.resolve();
    const onIdle = vi.fn();
    const dispatcher = createReplyDispatcher({ deliver, onIdle });

    dispatcher.sendToolResult({ text: "one" });
    dispatcher.sendFinalReply({ text: "two" });

    await dispatcher.waitForIdle();
    dispatcher.markComplete();
    await Promise.resolve();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("resolves an owner-declared follow-up admission barrier policy from queued deliveries", async () => {
    vi.useFakeTimers();
    try {
      const dispatcher = createReplyDispatcher({
        deliver: async () => {},
        resolveFollowupAdmissionBarrierTimeoutPolicy: ({ queuedCounts, humanDelayBudgetMs }) => ({
          maxTimeoutMs:
            Object.values(queuedCounts).reduce((sum, count) => sum + count, 0) * 35 * 60_000 +
            humanDelayBudgetMs,
          shouldExtend: () => true,
        }),
        humanDelay: { mode: "custom", minMs: 10_000, maxMs: 20_000 },
      });
      dispatcher.sendToolResult({ text: "tool" });
      dispatcher.sendBlockReply({ text: "block one" });
      dispatcher.sendBlockReply({ text: "block two" });
      dispatcher.sendFinalReply({ text: "final" });
      dispatcher.markComplete();

      const policy = dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.();
      expect(policy?.maxTimeoutMs).toBe(140 * 60_000 + 20_000);
      expect(policy?.shouldExtend()).toBe(true);
      await vi.runAllTimersAsync();
      await dispatcher.waitForIdle();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports each queued delivery settlement", async () => {
    const onDeliverySettled = vi.fn();
    const dispatcher = createReplyDispatcher({
      deliver: vi.fn().mockRejectedValueOnce(new Error("send failed")).mockResolvedValue(undefined),
      onDeliverySettled,
    });
    dispatcher.sendToolResult({ text: "tool" });
    dispatcher.sendFinalReply({ text: "final" });
    dispatcher.markComplete();

    await dispatcher.waitForIdle();
    expect(onDeliverySettled).toHaveBeenCalledTimes(2);
    expect(onDeliverySettled).toHaveBeenNthCalledWith(1, { kind: "tool" });
    expect(onDeliverySettled).toHaveBeenNthCalledWith(2, { kind: "final" });
  });

  it("delays block replies after the first when humanDelay is natural", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "natural" },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(799);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses custom bounds for humanDelay and clamps when max <= min", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createReplyDispatcher({
      deliver,
      humanDelay: { mode: "custom", minMs: 1200, maxMs: 400 },
    });

    dispatcher.sendBlockReply({ text: "first" });
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);

    dispatcher.sendBlockReply({ text: "second" });
    await vi.advanceTimersByTimeAsync(1199);
    expect(deliver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("waitForReplyDispatcherIdle", () => {
  it("returns when the abort signal fires before the dispatcher becomes idle", async () => {
    const controller = new AbortController();
    const waitForIdle = vi.fn(
      () =>
        new Promise<void>(() => {
          // Keep the dispatcher busy until the abort path wins.
        }),
    );

    let settled = false;
    const waitPromise = waitForReplyDispatcherIdle({ waitForIdle }, controller.signal).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    controller.abort();
    await waitPromise;

    expect(settled).toBe(true);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });
});

describe("createReplyToModeFilterForChannel", () => {
  it("handles off/all mode behavior for replyToId", () => {
    const cases: Array<{
      filter: ReturnType<typeof createReplyToModeFilterForChannel>;
      input: { text: string; replyToId?: string; replyToTag?: boolean };
      expectedReplyToId?: string;
    }> = [
      {
        filter: createReplyToModeFilterForChannel("off"),
        input: { text: "hi", replyToId: "1" },
        expectedReplyToId: undefined,
      },
      {
        filter: createReplyToModeFilterForChannel("off", "slack"),
        input: { text: "hi", replyToId: "1", replyToTag: true },
        expectedReplyToId: "1",
      },
      {
        filter: createReplyToModeFilterForChannel("all"),
        input: { text: "hi", replyToId: "1" },
        expectedReplyToId: "1",
      },
    ];
    for (const testCase of cases) {
      expect(testCase.filter(testCase.input).replyToId).toBe(testCase.expectedReplyToId);
    }
  });

  it("keeps only the first replyToId when mode is first", () => {
    const filter = createReplyToModeFilterForChannel("first");
    expect(filter({ text: "hi", replyToId: "1" }).replyToId).toBe("1");
    expect(filter({ text: "next", replyToId: "1" }).replyToId).toBeUndefined();
  });
});
