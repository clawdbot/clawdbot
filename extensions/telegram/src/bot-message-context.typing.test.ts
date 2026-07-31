// Telegram tests cover bot message context.typing plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  return expectDefined(mock.invocationCallOrder[0], context);
}

function createSendChatActionHandler(
  sendChatAction = vi.fn(async () => undefined),
): TelegramSendChatActionHandler & { sendChatAction: typeof sendChatAction } {
  return {
    sendChatAction,
    isSuspended: () => false,
    reset: () => undefined,
  };
}

describe("buildTelegramMessageContext typing", () => {
  it("sends direct typing after body resolution and before session context construction", async () => {
    const buildInboundContext = vi.fn(
      (params: Parameters<typeof buildChannelInboundEventContext>[0]) =>
        buildChannelInboundEventContext(params as never),
    );
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        sendChatActionHandler,
        sessionRuntime: {
          buildChannelInboundEventContext:
            buildInboundContext as unknown as typeof buildChannelInboundEventContext,
        },
      }),
    ).resolves.not.toBeNull();

    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(42, "typing", undefined);
    expect(
      requireInvocationOrder(sendChatActionHandler.sendChatAction.mock, "send typing invocation"),
    ).toBeLessThan(requireInvocationOrder(buildInboundContext.mock, "inbound context invocation"));
  });

  it("does not send direct typing when there is no replyable body", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: undefined,
        },
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("does not send early direct typing before DM access passes", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: 42, type: "private", first_name: "Pat" },
          from: { id: 42, first_name: "Pat" },
          text: "hello",
        },
        cfg: {
          agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
          channels: { telegram: { dmPolicy: "disabled", allowFrom: [] } },
          messages: { groupChat: { mentionPatterns: [] } },
        },
        dmPolicy: "disabled",
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("sends forum topic typing after accepted user-request classification and before context construction", async () => {
    const buildInboundContext = vi.fn(
      (params: Parameters<typeof buildChannelInboundEventContext>[0]) =>
        buildChannelInboundEventContext(params as never),
    );
    const sendChatActionHandler = createSendChatActionHandler();

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 42, first_name: "Pat" },
        message_thread_id: 99,
        text: "hello topic",
      },
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
      sendChatActionHandler,
      sessionRuntime: {
        buildChannelInboundEventContext:
          buildInboundContext as unknown as typeof buildChannelInboundEventContext,
      },
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(ctx?.initialTypingCueSent).toBe(true);
    expect(sendChatActionHandler.sendChatAction).toHaveBeenCalledWith(-1001234567890, "typing", {
      message_thread_id: 99,
    });
    expect(
      requireInvocationOrder(sendChatActionHandler.sendChatAction.mock, "send typing invocation"),
    ).toBeLessThan(requireInvocationOrder(buildInboundContext.mock, "inbound context invocation"));
  });

  it("does not send forum topic typing for room events", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    const ctx = await buildTelegramMessageContextForTest({
      cfg: { messages: { groupChat: { unmentionedInbound: "room_event", mentionPatterns: [] } } },
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
        from: { id: 42, first_name: "Pat" },
        message_thread_id: 99,
        text: "ambient chatter",
      },
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      }),
      sendChatActionHandler,
    });

    expect(ctx?.ctxPayload.InboundEventKind).toBe("room_event");
    expect(ctx?.initialTypingCueSent).toBe(false);
    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });

  it("does not send forum topic typing for unaddressed require-mention messages", async () => {
    const sendChatActionHandler = createSendChatActionHandler();

    await expect(
      buildTelegramMessageContextForTest({
        message: {
          chat: { id: -1001234567890, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: 42, first_name: "Pat" },
          message_thread_id: 99,
          text: "ambient chatter",
        },
        resolveGroupRequireMention: () => true,
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireMention: true },
          topicConfig: undefined,
        }),
        sendChatActionHandler,
      }),
    ).resolves.toBeNull();

    expect(sendChatActionHandler.sendChatAction).not.toHaveBeenCalled();
  });
});
