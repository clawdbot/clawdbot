// Feishu test support covers monitor.message handler plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./event-types.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

type MessageReceiveHandlerContext = Parameters<typeof createFeishuMessageReceiveHandler>[0];
type HandleMessageParams = Parameters<MessageReceiveHandlerContext["handleMessage"]>[0];

function createTextEvent(params: {
  messageId: string;
  senderOpenId: string;
  senderType: "bot" | "user";
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { open_id: params.senderOpenId },
      sender_type: params.senderType,
    },
    message: {
      message_id: params.messageId,
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    },
  };
}

function createHandler() {
  let onFlush: ((entries: FeishuMessageEvent[]) => Promise<void>) | undefined;
  const enqueue = vi.fn(async (event: FeishuMessageEvent) => {
    await onFlush?.([event]);
  });
  const channelRuntime = {
    commands: {
      isControlCommandMessage: () => false,
    },
    debounce: {
      resolveInboundDebounceMs: () => 0,
      createInboundDebouncer: vi.fn((params: { onFlush: typeof onFlush }) => {
        onFlush = params.onFlush;
        return { enqueue };
      }),
    },
  } as unknown as PluginRuntime["channel"];
  const handleMessage = vi.fn(async (_params: HandleMessageParams) => {});

  const handler = createFeishuMessageReceiveHandler({
    cfg: {} as ClawdbotConfig,
    channelRuntime,
    accountId: "default",
    chatHistories: new Map(),
    handleMessage,
    resolveDebounceText: () => "hello",
    hasProcessedMessage: vi.fn(async () => false),
    getBotOpenId: () => "ou_bot",
  });

  return { handler, handleMessage, enqueue };
}

describe("createFeishuMessageReceiveHandler self-message filtering", () => {
  it("drops the current bot before debounce and processing claims", async () => {
    const { handler, handleMessage, enqueue } = createHandler();

    await handler(
      createTextEvent({
        messageId: "om_reused",
        senderOpenId: "ou_bot",
        senderType: "bot",
      }),
    );
    await handler(
      createTextEvent({
        messageId: "om_reused",
        senderOpenId: "ou_user",
        senderType: "user",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0]?.[0]?.event.sender.sender_id.open_id).toBe("ou_user");
  });

  it("keeps peer bot and user messages flowing to dispatch", async () => {
    const { handler, handleMessage, enqueue } = createHandler();

    await handler(
      createTextEvent({
        messageId: "om_other_bot",
        senderOpenId: "ou_other_bot",
        senderType: "bot",
      }),
    );
    await handler(
      createTextEvent({
        messageId: "om_user",
        senderOpenId: "ou_user",
        senderType: "user",
      }),
    );

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(
      handleMessage.mock.calls.map(([params]) => params.event.sender.sender_id.open_id),
    ).toEqual(["ou_other_bot", "ou_user"]);
  });
});
