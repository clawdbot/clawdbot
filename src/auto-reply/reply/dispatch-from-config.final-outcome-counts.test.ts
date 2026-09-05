// Tests settled dispatcher outcome accounting for dispatch-from-config runs.
import { describe, expect, it } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { createReplyTurnLedger } from "./dispatch-from-config.turn-ledger.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
} from "./reply-dispatcher.js";

describe("settled dispatcher final outcomes", () => {
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
});
