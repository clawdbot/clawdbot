// Durable delivery tests cover persisted channel turn delivery attempts and recovery.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOutboundDurableFinalDeliverySupport: vi.fn(),
  sendDurableMessageBatch: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return {
    ...actual,
    resolveOutboundDurableFinalDeliverySupport: mocks.resolveOutboundDurableFinalDeliverySupport,
  };
});

vi.mock("../message/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../message/send.js")>();
  return {
    ...actual,
    sendDurableMessageBatch: mocks.sendDurableMessageBatch,
  };
});

import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { deliverInboundReplyWithMessageSendContext } from "./durable-delivery.js";

type SendDurableMessageBatchRequest = {
  cfg?: unknown;
  channel?: string;
  to?: string;
  threadId?: string | number | null;
  durability?: string;
  requireUnknownSendReconciliation?: boolean;
  gatewayClientScopes?: readonly string[];
};

type DeliverySupportRequest = {
  requirements?: Record<string, boolean>;
};

function ctxPayload(overrides: Partial<FinalizedMsgContext>): FinalizedMsgContext {
  return {
    CommandAuthorized: true,
    CommandTurn: {
      kind: "normal" as const,
      source: "message" as const,
      authorized: false as const,
    },
    ...overrides,
  };
}

function latestSendDurableMessageBatchRequest(): SendDurableMessageBatchRequest {
  const calls = mocks.sendDurableMessageBatch.mock.calls;
  const request = calls[calls.length - 1]?.[0];
  if (!request || typeof request !== "object") {
    throw new Error("expected sendDurableMessageBatch request");
  }
  return request as SendDurableMessageBatchRequest;
}

function latestDeliverySupportRequest(): DeliverySupportRequest {
  const calls = mocks.resolveOutboundDurableFinalDeliverySupport.mock.calls;
  const request = calls[calls.length - 1]?.[0];
  if (!request || typeof request !== "object") {
    throw new Error("expected delivery support request");
  }
  return request as DeliverySupportRequest;
}

describe("durable inbound reply delivery", () => {
  beforeEach(() => {
    mocks.resolveOutboundDurableFinalDeliverySupport.mockReset();
    mocks.sendDurableMessageBatch.mockReset();
    mocks.resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
    mocks.sendDurableMessageBatch.mockResolvedValue({
      status: "sent",
      receipt: {
        primaryPlatformMessageId: "m1",
        platformMessageIds: ["m1"],
        parts: [{ platformMessageId: "m1", kind: "text", index: 0 }],
        sentAt: 1,
      },
    });
  });

  it("preserves explicit null thread targets instead of falling back to context thread", async () => {
    await deliverInboundReplyWithMessageSendContext({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "plain reply" },
      threadId: null,
      ctxPayload: ctxPayload({
        OriginatingTo: "chat-1",
        MessageThreadId: "context-thread",
      }),
    });

    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    const request = latestSendDurableMessageBatchRequest();
    expect(request.cfg).toEqual({});
    expect(request.channel).toBe("telegram");
    expect(request.to).toBe("chat-1");
    expect(request.threadId).toBeNull();
    expect(request.durability).toBe("best_effort");
    expect(request.gatewayClientScopes).toEqual([]);
  });

  it("does not require unknown-send reconciliation for the default best-effort final path", async () => {
    await deliverInboundReplyWithMessageSendContext({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final" },
      ctxPayload: ctxPayload({
        OriginatingTo: "chat-1",
      }),
    });

    expect(mocks.resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledTimes(1);
    expect(latestDeliverySupportRequest().requirements).toEqual({
      text: true,
      messageSendingHooks: true,
    });
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(latestSendDurableMessageBatchRequest().durability).toBe("best_effort");
    expect(latestSendDurableMessageBatchRequest().requireUnknownSendReconciliation).toBeUndefined();
  });

  it("uses required durability when a caller explicitly requires unknown-send reconciliation", async () => {
    await deliverInboundReplyWithMessageSendContext({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final" },
      requiredCapabilities: {
        text: true,
        reconcileUnknownSend: true,
      },
      ctxPayload: ctxPayload({
        OriginatingTo: "chat-1",
      }),
    });

    expect(mocks.resolveOutboundDurableFinalDeliverySupport).toHaveBeenCalledTimes(1);
    expect(latestDeliverySupportRequest().requirements).toEqual({
      text: true,
      reconcileUnknownSend: true,
    });
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(latestSendDurableMessageBatchRequest().durability).toBe("required");
    expect(latestSendDurableMessageBatchRequest().requireUnknownSendReconciliation).toBe(true);
  });

  it("reports durable partial send failures as failed delivery", async () => {
    const error = new Error("second chunk failed");
    mocks.sendDurableMessageBatch.mockResolvedValueOnce({
      status: "partial_failed",
      results: [{ channel: "telegram", messageId: "m1" }],
      receipt: {
        primaryPlatformMessageId: "m1",
        platformMessageIds: ["m1"],
        parts: [{ platformMessageId: "m1", kind: "text", index: 0 }],
        sentAt: 1,
      },
      error,
      sentBeforeError: true,
    });

    const result = await deliverInboundReplyWithMessageSendContext({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final" },
      ctxPayload: ctxPayload({
        OriginatingTo: "chat-1",
      }),
    });

    expect(result).toEqual({ status: "failed", error, sentBeforeError: true });
    expect(error).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  });
});
