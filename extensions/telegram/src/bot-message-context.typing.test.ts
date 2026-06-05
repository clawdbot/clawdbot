// Telegram tests cover bot message context.typing plugin behavior.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import type { TelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

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
    expect(sendChatActionHandler.sendChatAction.mock.invocationCallOrder[0]).toBeLessThan(
      buildInboundContext.mock.invocationCallOrder[0],
    );
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
});
