// Delivery result tests cover channel turn delivery result normalization.
import { describe, expect, it } from "vitest";
import type { MessageReceipt } from "../message/types.js";
import {
  createAcceptedChannelDeliveryResult,
  createChannelDeliveryResultFromReceipt,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "./delivery-result.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatchFromReceipt as hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";

describe("createAcceptedChannelDeliveryResult", () => {
  it.each([true, false])(
    "retains accepted prefixes and nested partial identities (receipt=%s)",
    (withReceipt) => {
      const nestedReceipt: MessageReceipt = {
        primaryPlatformMessageId: "attachment",
        platformMessageIds: ["attachment", "caption"],
        parts: [
          { platformMessageId: "attachment", kind: "media", index: 0, threadId: "native-thread" },
        ],
        sentAt: 123,
      };
      const result = createAcceptedChannelDeliveryResult({
        results: [{ messageId: "prefix" }],
        deliveryResults: [
          {
            visibleReplySent: true,
            messageIds: withReceipt ? ["stale-legacy-id"] : ["attachment", "caption"],
            ...(withReceipt ? { receipt: nestedReceipt } : {}),
          },
        ],
        kind: "media",
        content: "accepted prefix\naccepted attachment",
      });

      expect(result.messageIds).toEqual(["prefix", "attachment", "caption"]);
      expect(result.content).toBe("accepted prefix\naccepted attachment");
      expect(result.visibleReplySent).toBe(true);
      expect(result).not.toHaveProperty("threadId");
      expect(result.receipt.parts[0]?.platformMessageId).toBe("prefix");
      if (withReceipt) {
        expect(result.receipt.parts[1]).toEqual(nestedReceipt.parts[0]);
      }
    },
  );

  it("preserves identityless accepted delivery without inventing routing or text", () => {
    const result = createAcceptedChannelDeliveryResult({});
    expect(result).toMatchObject({
      messageIds: [],
      receipt: { platformMessageIds: [], parts: [] },
      visibleReplySent: true,
    });
    expect(result).not.toHaveProperty("content");
    expect(result).not.toHaveProperty("threadId");
  });
});

describe("createChannelDeliveryResultFromReceipt", () => {
  it("keeps legacy messageIds while attaching the receipt", () => {
    const receipt = {
      primaryPlatformMessageId: "m1",
      platformMessageIds: ["m1", "m2"],
      parts: [],
      threadId: "canonical-thread",
      sentAt: 123,
    };

    expect(
      createChannelDeliveryResultFromReceipt({
        receipt,
        threadId: "requested-thread",
        replyToId: "reply-1",
        visibleReplySent: true,
        deliveryIntent: {
          id: "intent-1",
          kind: "outbound_queue",
          queuePolicy: "required",
        },
      }),
    ).toEqual({
      messageIds: ["m1", "m2"],
      receipt,
      threadId: "canonical-thread",
      replyToId: "reply-1",
      visibleReplySent: true,
      deliveryIntent: {
        id: "intent-1",
        kind: "outbound_queue",
        queuePolicy: "required",
      },
    });
  });

  it("does not restore the requested route when provider receipt parts conflict", () => {
    const receipt: MessageReceipt = {
      platformMessageIds: ["m1", "m2"],
      parts: [
        { platformMessageId: "m1", kind: "text", index: 0, threadId: "thread-1" },
        { platformMessageId: "m2", kind: "text", index: 1, threadId: "thread-2" },
      ],
      sentAt: 123,
    };

    const result = createChannelDeliveryResultFromReceipt({
      receipt,
      threadId: "requested-thread",
      visibleReplySent: true,
    });

    expect(result).not.toHaveProperty("threadId");
    expect(result.receipt).toBe(receipt);
  });

  it("preserves suppressed receipt results without synthetic message ids", () => {
    const receipt = {
      platformMessageIds: [],
      parts: [],
      sentAt: 123,
    };

    expect(
      createChannelDeliveryResultFromReceipt({
        receipt,
        visibleReplySent: false,
      }),
    ).toEqual({
      receipt,
      visibleReplySent: false,
    });
  });
});

describe("channel partial delivery errors", () => {
  it("carries nested provider facts and top-level visibility markers", () => {
    const cause = new Error("final edit failed");
    const error = createChannelPartialDeliveryError(cause, {
      content: "accepted preview",
      messageIds: ["provider-1"],
      visibleReplySent: true,
    });

    expect(error).toMatchObject({
      cause,
      code: "CHANNEL_PARTIAL_DELIVERY",
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        content: "accepted preview",
        messageIds: ["provider-1"],
        visibleReplySent: true,
      },
    });
    expect(isChannelPartialDeliveryError(error)).toBe(true);
  });

  it("recognizes the documented structural envelope", () => {
    expect(
      isChannelPartialDeliveryError({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: true },
      }),
    ).toBe(true);
    expect(
      isChannelPartialDeliveryError({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: false },
      }),
    ).toBe(false);
  });
});

describe("channel turn dispatch results", () => {
  it("normalizes visible dispatch checks", () => {
    expect(hasVisibleChannelTurnDispatch(undefined)).toBe(false);
    expect(
      hasVisibleChannelTurnDispatch({
        queuedFinal: false,
        counts: { tool: 1, block: 0, final: 0 },
      }),
    ).toBe(false);
    expect(
      hasVisibleChannelTurnDispatch({
        settledReceipt: {
          anyVisibleDelivered: true,
          counts: { tool: { delivered: 1, failedAfterSend: 0 } },
        },
      }),
    ).toBe(true);
    expect(
      hasVisibleChannelTurnDispatch(undefined, {
        observedReplyDelivery: true,
      }),
    ).toBe(true);
    expect(
      hasFinalChannelTurnDispatch({
        settledReceipt: {
          anyVisibleDelivered: true,
          counts: { tool: { delivered: 1, failedAfterSend: 0 } },
        },
      }),
    ).toBe(false);
    expect(resolveChannelTurnDispatchCounts(undefined)).toEqual({
      tool: 0,
      block: 0,
      final: 0,
    });
  });
});
