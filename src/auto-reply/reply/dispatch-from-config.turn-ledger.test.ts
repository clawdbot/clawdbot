import { describe, expect, it, vi } from "vitest";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

function createUntrackedDispatcher(overrides: Partial<ReplyDispatcher> = {}): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
    ...overrides,
  };
}

describe("createReplyTurnLedger", () => {
  it("counts a delivered contentful payload as visible after settlement", async () => {
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    const ledger = createReplyTurnLedger(dispatcher);
    const send = ledger.sendQueued("final", { text: "hello" });
    expect(send.queued).toBe(true);
    expect(send.outcome).toBeDefined();
    await ledger.settleQueued();
    expect(ledger.hasVisibleDelivery()).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("does not count a beforeDeliver-cancelled payload as visible", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({ deliver, beforeDeliver: async () => null });
    const ledger = createReplyTurnLedger(dispatcher);
    expect(ledger.sendQueued("final", { text: "hello" }).queued).toBe(true);
    await ledger.settleQueued();
    expect(deliver).not.toHaveBeenCalled();
    expect(ledger.hasVisibleDelivery()).toBe(false);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("does not count a pre-transport failure as visible", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver,
      beforeDeliver: async () => {
        throw new Error("hook exploded");
      },
    });
    const ledger = createReplyTurnLedger(dispatcher);
    expect(ledger.sendQueued("block", { text: "streamed" }).queued).toBe(true);
    await ledger.settleQueued();
    expect(deliver).not.toHaveBeenCalled();
    expect(ledger.hasVisibleDelivery()).toBe(false);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("conservatively counts a started-then-failed delivery as visible", async () => {
    // Chunked transports may show partial content before rejecting; core cannot
    // prove invisibility, so the fallback must stay quiet.
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw new Error("transport down mid-send");
      },
    });
    const ledger = createReplyTurnLedger(dispatcher);
    expect(ledger.sendQueued("block", { text: "streamed" }).queued).toBe(true);
    await ledger.settleQueued();
    expect(ledger.hasVisibleDelivery()).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });

  it("times out instead of waiting forever on a transport that never settles", async () => {
    vi.useFakeTimers();
    try {
      let releaseDeliver!: () => void;
      const stalled = new Promise<void>((resolve) => {
        releaseDeliver = resolve;
      });
      const dispatcher = createReplyDispatcher({ deliver: () => stalled });
      const ledger = createReplyTurnLedger(dispatcher);
      ledger.sendQueued("final", { text: "hello" });
      const settle = ledger.settleQueued();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(settle).resolves.toBe("timed-out");
      releaseDeliver();
      dispatcher.markComplete();
      await vi.runAllTimersAsync();
      await dispatcher.waitForIdle();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps legacy accepted sends visible when settlement has no receipt", async () => {
    const ledger = createReplyTurnLedger(createUntrackedDispatcher());
    const send = ledger.sendQueued("final", { text: "hello" });
    expect(send.outcome).toBeUndefined();
    await ledger.settleQueued();
    expect(ledger.hasVisibleDelivery()).toBe(true);
  });

  it("does not fabricate visibility when a receipt-capable dispatcher omits its receipt", async () => {
    const ledger = createReplyTurnLedger(
      createUntrackedDispatcher({ supportsSettledReceipt: true }),
    );
    ledger.sendQueued("final", { text: "hello" });
    await ledger.settleQueued();
    expect(ledger.hasVisibleDelivery()).toBe(false);
  });

  it("records routed settlements only when delivered and contentful", () => {
    const ledger = createReplyTurnLedger(createUntrackedDispatcher());
    ledger.recordRoutedDelivery({ text: "suppressed" }, false);
    ledger.recordRoutedDelivery({ text: "" }, true);
    expect(ledger.hasVisibleDelivery()).toBe(false);
    ledger.recordRoutedDelivery({ mediaUrl: "https://example.com/seatmap.png" }, true);
    expect(ledger.hasVisibleDelivery()).toBe(true);
  });

  it("stops settling when the abort signal fires", async () => {
    // A stalled deliver models a hung transport; abort must release the gate
    // instead of wedging finalization.
    let releaseDeliver!: () => void;
    const stalled = new Promise<void>((resolve) => {
      releaseDeliver = resolve;
    });
    const dispatcher = createReplyDispatcher({ deliver: () => stalled });
    const ledger = createReplyTurnLedger(dispatcher);
    ledger.sendQueued("final", { text: "hello" });
    const abortController = new AbortController();
    const settled = ledger.settleQueued(abortController.signal);
    abortController.abort();
    await expect(settled).resolves.toBe("aborted");
    expect(ledger.hasVisibleDelivery()).toBe(false);
    releaseDeliver();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  });
});
