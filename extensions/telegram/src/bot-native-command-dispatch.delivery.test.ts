import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannelPartialDeliveryError,
  createDeferred,
  dispatchReplyResult,
  dispatchChannelInboundTurnMock,
  executorTestMocks,
  firstMockArg,
  registerAndResolveStatusHandler,
  requireRecord,
  requireValue,
  resetSessionMetaMocks,
} from "./bot-native-command-executors.test-support.js";
import type { DispatchReplyWithBufferedBlockDispatcherParams } from "./bot-native-command-executors.test-support.js";
import { createTelegramPrivateCommandContext } from "./bot-native-commands.fixture-test-support.js";

type DeliverRepliesParams = Parameters<typeof import("./bot/delivery.js").deliverReplies>[0];

const { deliveryMocks, replyMocks, sessionMocks } = executorTestMocks;

describe("Telegram native command dispatch delivery", () => {
  beforeEach(resetSessionMetaMocks);

  it("awaits routed session metadata persistence before command dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);

    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(createTelegramPrivateCommandContext());

    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    const dispatcherOptions = requireRecord(
      requireRecord(
        firstMockArg(
          replyMocks.dispatchReplyWithBufferedBlockDispatcher,
          "dispatchReplyWithBufferedBlockDispatcher",
        ),
        "dispatch reply params",
      ).dispatcherOptions,
      "dispatcher options",
    );
    expect(dispatcherOptions.beforeDeliver).toBeTypeOf("function");
  });

  it("does not inject approval buttons for native command replies once the monitor owns approvals", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Mode: foreground\nRun: /approve 7f423fdc allow-once (or allow-always / deny).",
          },
          { kind: "final" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = firstMockArg(deliveryMocks.deliverReplies, "deliverReplies") as
      | DeliverRepliesParams
      | undefined;
    const deliveredPayload = deliveredCall?.replies?.[0];
    if (!deliveredPayload) {
      throw new Error("expected approval reply payload to be delivered");
    }
    expect(deliveredPayload?.["text"]).toContain("/approve 7f423fdc allow-once");
    expect(deliveredPayload?.["channelData"]).toBeUndefined();
  });

  it("suppresses local structured exec approval replies for native commands", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
            channelData: {
              execApproval: {
                approvalId: "7f423fdc-1111-2222-3333-444444444444",
                approvalSlug: "7f423fdc",
                allowedDecisions: ["allow-once", "allow-always", "deny"],
              },
            },
          },
          { kind: "tool" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit the empty fallback when reply-payload hooks cancel a native reply", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      await plan.delivery.onDelivered?.(
        { text: "cancelled" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit the empty fallback for a message-tool-only native reply", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      plan.dispatcherOptions?.onSkip?.({}, { kind: "final", reason: "empty" });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("retains the native fallback when message-tool-only delivery also fails", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      plan.dispatcherOptions?.onSkip?.({}, { kind: "final", reason: "empty" });
      plan.delivery.onError?.(new Error("Telegram final delivery failed"), {
        kind: "final",
      });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledOnce();
    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  it("emits the fallback when a non-final suppression precedes a final failure", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      await plan.delivery.onDelivered?.(
        { text: "cancelled tool reply" },
        { kind: "tool" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      plan.delivery.onError?.(new Error("Telegram final delivery failed"), {
        kind: "final",
      });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledOnce();
    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  it("emits the fallback when a suppressed block reply precedes a final failure", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      await plan.delivery.onDelivered?.(
        { text: "cancelled block reply" },
        { kind: "block" },
        {
          visibleReplySent: false,
          suppression: { reason: "empty_after_reply_payload_sending_hook" },
        },
      );
      plan.delivery.onError?.(new Error("Telegram final delivery failed"), {
        kind: "final",
      });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledOnce();
  });

  it("emits the fallback when a final failure precedes a later suppressed final", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      plan.delivery.onError?.(new Error("Telegram final delivery failed"), {
        kind: "final",
      });
      await plan.delivery.onDelivered?.(
        { text: "cancelled final reply" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledOnce();
  });

  it("preserves a suppressed final after a non-final delivery failure", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      plan.delivery.onError?.(new Error("Telegram tool delivery failed"), {
        kind: "tool",
      });
      await plan.delivery.onDelivered?.(
        { text: "cancelled final reply" },
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
        },
      );
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit the fallback after a partially delivered final", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      plan.delivery.onError?.(
        createChannelPartialDeliveryError(new Error("Telegram final delivery failed"), {
          visibleReplySent: true,
        }),
        { kind: "final" },
      );
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("retains the empty fallback for a true non-silent metadata-only native reply", async () => {
    dispatchChannelInboundTurnMock.mockImplementationOnce(async (plan) => {
      plan.dispatcherOptions?.onSkip?.({}, { kind: "final", reason: "empty" });
      return {
        admission: { kind: "dispatch" },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        },
      };
    });
    const { handler } = registerAndResolveStatusHandler({ cfg: {} });

    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledOnce();
    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  it("sends native command error replies silently when silentErrorReplies is enabled", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver({ text: "oops", isError: true }, { kind: "final" });
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            silentErrorReplies: true,
          },
        },
      },
      telegramCfg: { silentErrorReplies: true },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = firstMockArg(deliveryMocks.deliverReplies, "deliverReplies") as
      | DeliverRepliesParams
      | undefined;
    const deliveryParams = requireValue(deliveredCall, "silent error delivery params");
    expect(deliveryParams.silent).toBe(true);
    expect(deliveryParams.replies).toHaveLength(1);
    expect(deliveryParams.replies[0]?.isError).toBe(true);
  });
});
