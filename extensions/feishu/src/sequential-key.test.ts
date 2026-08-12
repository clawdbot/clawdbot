// Feishu tests cover sequential key plugin behavior.
import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
  chatType?: "p2p" | "group" | "topic_group";
  mentions?: Array<{ key: string; name: string; id: { open_id?: string; user_id?: string } }>;
}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou_sender_1",
        user_id: "ou_user_1",
      },
      sender_type: "user",
    },
    message: {
      message_id: params.messageId ?? "om_message_1",
      chat_id: params.chatId ?? "oc_dm_chat",
      chat_type: params.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: params.mentions,
    },
  } as FeishuMessageEvent;
}

describe("getFeishuSequentialKey", () => {
  it.each([
    [createTextEvent({ text: "hello" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/status" }), "feishu:default:oc_dm_chat"],
    [createTextEvent({ text: "/stop" }), "feishu:default:oc_dm_chat:control"],
    [createTextEvent({ text: "/btw what changed?" }), "feishu:default:oc_dm_chat:btw"],
  ])("resolves sequential key %#", (event, expected) => {
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe(expected);
  });

  it("keeps /btw on a stable per-chat lane across different message ids", () => {
    const first = createTextEvent({ text: "/btw one", messageId: "om_message_1" });
    const second = createTextEvent({ text: "/btw two", messageId: "om_message_2" });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: first,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event: second,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("does not classify a p2p mention-forwarded /stop as a control command", () => {
    // p2p keeps non-bot mentions for mention forwarding (the command owner
    // strips mentions only in groups), so "@Bot @Alice /stop" must stay on the
    // base lane instead of entering :control (ClawSweeper P2 on #119243).
    const event = createTextEvent({
      text: "@Alice /stop",
      chatType: "p2p",
      mentions: [{ key: "@Alice", name: "Alice", id: { open_id: "ou_alice" } }],
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot",
        botName: "Bot",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });

  it("classifies a group @Bot /stop as a control command", () => {
    // Group content keeps the bot's own <at> tag (#72504); the sequential key
    // strips it so the :control lane still matches dispatch.
    const event = createTextEvent({
      text: "@Bot /stop",
      chatType: "group",
      mentions: [{ key: "@Bot", name: "Bot", id: { open_id: "ou_bot" } }],
    });

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot",
        botName: "Bot",
      }),
    ).toBe("feishu:default:oc_dm_chat:control");
  });

  it("falls back to a stable btw lane when the message id is unavailable", () => {
    const event = createTextEvent({ text: "/btw what changed?" });
    delete (event.message as { message_id?: string }).message_id;

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
      }),
    ).toBe("feishu:default:oc_dm_chat:btw");
  });

  it("keeps an empty group message with bot mentions on its normal chat lane", () => {
    const event = createTextEvent({ text: "" });
    event.message.chat_type = "group";
    event.message.content = "";
    event.message.mentions = [
      {
        key: "@_bot_1",
        id: { open_id: "ou_bot_1" },
        name: "OpenClaw",
      },
    ];

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot_1",
      }),
    ).toBe("feishu:default:oc_dm_chat");
  });

  it("selects the control lane for a group /stop with the bot's own mention kept", () => {
    const event = createTextEvent({ text: "@_bot_1 /stop", chatId: "oc_group_chat" });
    event.message.chat_type = "group";
    event.message.mentions = [
      {
        key: "@_bot_1",
        id: { open_id: "ou_bot_1" },
        name: "OpenClaw",
      },
    ];

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot_1",
      }),
    ).toBe("feishu:default:oc_group_chat:control");
  });

  it("selects the btw lane for a group /btw with the bot's own mention kept", () => {
    const event = createTextEvent({
      text: "@_bot_1 /btw what changed?",
      chatId: "oc_group_chat",
    });
    event.message.chat_type = "group";
    event.message.mentions = [
      {
        key: "@_bot_1",
        id: { open_id: "ou_bot_1" },
        name: "OpenClaw",
      },
    ];

    expect(
      getFeishuSequentialKey({
        accountId: "default",
        event,
        botOpenId: "ou_bot_1",
      }),
    ).toBe("feishu:default:oc_group_chat:btw");
  });
});
