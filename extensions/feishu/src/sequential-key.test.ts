import { describe, expect, it } from "vitest";
import type { FeishuMessageEvent } from "./bot.js";
import { getFeishuSequentialKey } from "./sequential-key.js";

function createTextEvent(params: {
  text: string;
  messageId?: string;
  chatId?: string;
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
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
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
});
