// Tests settled dispatcher outcome accounting for dispatch-from-config runs.
import { describe, expect, it } from "vitest";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
} from "./reply-dispatcher.js";

describe("settled dispatcher final outcomes", () => {
  it.each([
    { visibleReplySent: false, deferred: false },
    { visibleReplySent: true, deferred: false },
    { visibleReplySent: false, deferred: true },
    { visibleReplySent: true, deferred: true },
  ])(
    "keeps identityless delivery pending in the exact receipt ($visibleReplySent, $deferred)",
    async ({ visibleReplySent, deferred }) => {
      const attempted: string[] = [];
      const uncertain = {
        visibleReplySent,
        suppression: { reason: "adapter_returned_no_identity" },
      };
      const payload = { text: "primary" };
      attachReplyDispatchUndeliveredFallback(payload, { text: "alternative" });
      const capture = captureReplyDispatchDeliveryOutcome(payload);
      const dispatcher = createReplyDispatcher({
        deliver: async (reply) => {
          attempted.push(reply.text ?? "");
          return deferred ? { finalization: Promise.resolve(uncertain) } : uncertain;
        },
      });
      dispatcher.sendFinalReply(payload);
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      expect(attempted).toEqual(["primary"]);
      expect(receipt).toMatchObject({
        anyVisibleDelivered: false,
        hasPendingDelivery: true,
        counts: { final: { delivered: 0, deliveredNotVisible: 1 } },
      });
      await expect(capture.promise).resolves.toBe("delivered-not-visible");
      expect(capture.hasPendingDelivery()).toBe(true);
    },
  );

  it.each(["channel_transform", "no_visible_result"])(
    "keeps %s distinct when a payload has an undelivered alternative",
    async (reason) => {
      const delivered: string[] = [];
      const payload = { text: "primary" };
      const outcome = captureReplyDispatchDeliveryOutcome(payload);
      attachReplyDispatchUndeliveredFallback(payload, { text: "alternative" });
      const dispatcher = createReplyDispatcher({
        deliver: async (reply) => {
          delivered.push(reply.text ?? "");
          return reply.text === "primary"
            ? { visibleReplySent: false, suppression: { reason } }
            : { visibleReplySent: true };
        },
      });

      const ledger = createReplyTurnLedger(dispatcher);
      const send = ledger.sendQueued("final", payload);
      expect(send.queued).toBe(true);
      expect(outcome.isTracked()).toBe(true);
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      const suppressed = reason === "channel_transform";
      expect(delivered).toEqual(suppressed ? ["primary"] : ["primary", "alternative"]);
      await expect(outcome.promise).resolves.toBe(suppressed ? "channel-transform" : "delivered");
      await expect(send.outcome).resolves.toBe(suppressed ? "channel-transform" : "delivered");
      expect(receipt?.anyVisibleDelivered).toBe(!suppressed);
      expect(receipt?.counts.final.deliveredNotVisible).toBe(suppressed ? 1 : 0);
    },
  );

  it("keeps a reused payload's next receipt when its previous delivery settles", async () => {
    let delivered = false;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        const visibleReplySent = !delivered;
        delivered = true;
        return { visibleReplySent };
      },
    });
    const ledger = createReplyTurnLedger(dispatcher);
    const payload = { text: "reply" };
    const first = ledger.sendQueued("final", payload);
    const next = captureReplyDispatchDeliveryOutcome(payload);
    await expect(first.outcome).resolves.toBe("delivered");
    const second = ledger.sendQueued("final", payload);
    expect(next.isTracked()).toBe(true);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    await expect(next.promise).resolves.toBe("delivered-not-visible");
    await expect(second.outcome).resolves.toBe("delivered-not-visible");
    expect(receipt?.counts.final).toMatchObject({ delivered: 1, deliveredNotVisible: 1 });
  });

  it("shares pending custody within one enqueue and isolates reuse of the same payload", async () => {
    let attempts = 0;
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        if (attempts++ === 0) {
          throw Object.assign(
            new OutboundDeliveryError("queued", {
              cause: new PlatformMessageNotDispatchedError("offline", { cause: undefined }),
            }),
            { queueCustody: "held" as const },
          );
        }
      },
    });
    const ledger = createReplyTurnLedger(dispatcher);
    const payload = { text: "same object" };
    const first = captureReplyDispatchDeliveryOutcome(payload);
    const nested = captureReplyDispatchDeliveryOutcome(payload);
    const firstSend = ledger.sendQueued("block", payload);
    const next = captureReplyDispatchDeliveryOutcome(payload);
    await expect(firstSend.outcome).resolves.toBe("failed-before-deliver");

    const secondSend = ledger.sendQueued("final", payload);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    await expect(first.promise).resolves.toBe("failed-before-deliver");
    await expect(nested.promise).resolves.toBe("failed-before-deliver");
    await expect(next.promise).resolves.toBe("delivered");
    expect([
      first.hasPendingDelivery(),
      nested.hasPendingDelivery(),
      firstSend.hasPendingDelivery?.(),
      next.hasPendingDelivery(),
      secondSend.hasPendingDelivery?.(),
    ]).toEqual([true, true, true, false, false]);
  });

  it("rethrows an opted-in proven no-send failure when nothing was visible", async () => {
    const error = new PlatformMessageNotDispatchedError("offline before dispatch", {
      cause: new Error("offline"),
    });
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw error;
      },
      propagateRetryableNoSendFailure: true,
    });

    dispatcher.sendFinalReply({ text: "retry me" });
    dispatcher.markComplete();

    await expect(dispatcher.waitForIdle()).rejects.toBe(error);
  });

  it("keeps non-visible, pre-send, and post-send outcomes distinct", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async (_payload, info) => {
        if (info.kind === "tool") {
          return { visibleReplySent: false };
        }
        if (info.kind === "block") {
          throw Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          });
        }
        throw new Error("send outcome unknown");
      },
    });

    dispatcher.sendToolResult({ text: "hidden" });
    dispatcher.sendBlockReply({ text: "never sent" });
    dispatcher.sendFinalReply({ text: "maybe sent" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(receipt).toMatchObject({
      counts: {
        tool: { deliveredNotVisible: 1 },
        block: { failedBeforeSend: 1 },
        final: { failedAfterSend: 1 },
      },
      anyVisibleDelivered: true,
    });
  });

  it.each([
    { finalFirst: false, queueCustody: "held" },
    { finalFirst: true, queueCustody: "held" },
    { finalFirst: false, queueCustody: "released" },
    { finalFirst: true, queueCustody: "released" },
  ] as const)(
    "does not retry a turn when siblings retain custody ($queueCustody, finalFirst=$finalFirst)",
    async ({ finalFirst, queueCustody }) => {
      const error = new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      });
      const finalError = Object.assign(new OutboundDeliveryError(error.message, { cause: error }), {
        queueCustody,
      });
      const dispatcher = createReplyDispatcher({
        deliver: async (_payload, info) => {
          throw info.kind === "final" ? finalError : error;
        },
        propagateRetryableNoSendFailure: true,
      });
      if (finalFirst) {
        dispatcher.sendFinalReply({ text: "answer" });
      }
      dispatcher.sendBlockReply({ text: "progress" });
      if (!finalFirst) {
        dispatcher.sendFinalReply({ text: "answer" });
      }
      dispatcher.markComplete();

      if (queueCustody === "held") {
        await expect(dispatcher.waitForIdle()).resolves.toMatchObject({
          anyVisibleDelivered: false,
          hasPendingDelivery: true,
          counts: { block: { failedBeforeSend: 1 }, final: { failedBeforeSend: 1 } },
        });
        const ledger = createReplyTurnLedger(dispatcher);
        await ledger.settleQueued();
        expect(ledger.hasPendingDelivery()).toBe(true);
        expect(ledger.hasVisibleDelivery()).toBe(false);
      } else {
        await expect(dispatcher.waitForIdle()).rejects.toBe(finalFirst ? finalError : error);
      }
    },
  );
});
