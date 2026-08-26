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
    sendDurableMessageBatchCore: mocks.sendDurableMessageBatch,
  };
});

import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";

type SendDurableMessageBatchRequest = {
  cfg?: unknown;
  channel?: string;
  to?: string;
  reply?: { source: "explicit" | "implicit"; replyToId: string };
  replyToId?: string | null;
  replyToMode?: string;
  threadId?: string | number | null;
  durability?: string;
  requireUnknownSendReconciliation?: boolean;
  gatewayClientScopes?: readonly string[];
  runId?: string;
  executionIdentityToken?: unknown;
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
    await deliverInboundReplyWithMessageSendContextCore({
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

  it.each([
    {
      name: "an explicit current-message reply",
      payload: { text: "current", replyToCurrent: true },
      replyToId: "700",
      expectedReply: { source: "explicit", replyToId: "700" },
    },
    {
      name: "an explicit reply tag",
      payload: { text: "tagged", replyToTag: true },
      replyToId: "701",
      expectedReply: { source: "explicit", replyToId: "701" },
    },
    {
      name: "an implicit reply",
      payload: { text: "implicit" },
      replyToId: "702",
      expectedReply: undefined,
    },
    {
      name: "a compaction notice",
      payload: { text: "compacting", replyToCurrent: true, isCompactionNotice: true },
      replyToId: "703",
      expectedReply: undefined,
    },
  ])("keeps $name explicit when durable implicit replies are off", async (testCase) => {
    await deliverInboundReplyWithMessageSendContextCore({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: testCase.payload,
      replyToId: testCase.replyToId,
      replyToMode: "off",
      ctxPayload: ctxPayload({ OriginatingTo: "chat-1" }),
    });

    const request = latestSendDurableMessageBatchRequest();
    expect(request.reply).toEqual(testCase.expectedReply);
    expect(request.replyToId).toBe(testCase.replyToId);
    expect(request.replyToMode).toBe("off");
  });

  it("does not require unknown-send reconciliation for the default best-effort final path", async () => {
    const executionIdentityToken = createExecutionIdentityAdmissionToken("run-exact");
    await deliverInboundReplyWithMessageSendContextCore({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final" },
      executionIdentityToken,
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
    expect(latestSendDurableMessageBatchRequest()).toMatchObject({
      runId: "run-exact",
      executionIdentityToken,
    });
    expect(latestSendDurableMessageBatchRequest().requireUnknownSendReconciliation).toBeUndefined();
  });

  it("uses required durability when a caller explicitly requires unknown-send reconciliation", async () => {
    await deliverInboundReplyWithMessageSendContextCore({
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
      results: [
        {
          channel: "telegram",
          messageId: "m1",
          meta: { visibleText: "formatted accepted prefix" },
        },
      ],
      receipt: {
        primaryPlatformMessageId: "m1",
        platformMessageIds: ["m1"],
        parts: [{ platformMessageId: "m1", kind: "text", index: 0 }],
        sentAt: 1,
      },
      error,
      sentBeforeError: true,
      deliveryIntent: {
        id: "queue-1",
        channel: "telegram",
        to: "chat-1",
        queuePolicy: "best_effort",
      },
    });

    const result = await deliverInboundReplyWithMessageSendContextCore({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final" },
      replyToId: "source-1",
      threadId: "thread-1",
      ctxPayload: ctxPayload({
        OriginatingTo: "chat-1",
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      sentBeforeError: true,
      error: {
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: error,
        deliveryResult: {
          messageIds: ["m1"],
          receipt: expect.objectContaining({ primaryPlatformMessageId: "m1" }),
          visibleReplySent: true,
          content: "formatted accepted prefix",
          replyToId: "source-1",
          threadId: "thread-1",
          deliveryIntent: {
            id: "queue-1",
            kind: "outbound_queue",
            queuePolicy: "best_effort",
          },
        },
      },
    });
    expect(() => throwIfDurableInboundReplyDeliveryFailed(result)).toThrow(
      expect.objectContaining({ code: "CHANNEL_PARTIAL_DELIVERY" }),
    );
    expect(error).not.toHaveProperty("sentBeforeError");
  });

  it.each([
    {
      label: "proven no-dispatch",
      error: new PlatformMessageNotDispatchedError("offline before dispatch", {
        cause: new Error("offline"),
      }),
    },
    { label: "ambiguous first-send", error: new Error("socket closed") },
  ])("keeps a $label failure non-visible and preserves its retry contract", async ({ error }) => {
    mocks.sendDurableMessageBatch.mockResolvedValueOnce({ status: "failed", error });

    const result = await deliverInboundReplyWithMessageSendContextCore({
      cfg: {},
      channel: "telegram",
      agentId: "main",
      info: { kind: "final" },
      payload: { text: "final" },
      ctxPayload: ctxPayload({ OriginatingTo: "chat-1" }),
    });

    expect(result).toEqual({ status: "failed", error });
    expect(error).not.toHaveProperty("visibleReplySent");
    expect(error).not.toHaveProperty("sentBeforeError");
  });
});
