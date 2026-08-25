import { describe, expect, it } from "vitest";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";

function textEvent(overrides: {
  messageId: string;
  createTime?: string;
  senderOpenId?: string;
  chatId?: string;
  text?: string;
}): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: overrides.senderOpenId ?? "ou-user" } },
    message: {
      message_id: overrides.messageId,
      chat_id: overrides.chatId ?? "oc-dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: overrides.text ?? "hello" }),
      create_time: overrides.createTime,
    },
  };
}

describe("resolveFeishuMessageDedupeKey", () => {
  it("collapses redelivered text with a fresh message_id but identical sender/chat/create_time/content (#46778)", () => {
    const first = resolveFeishuMessageDedupeKey(
      textEvent({ messageId: "om_first", createTime: "1710000000000" }),
    );
    const retry = resolveFeishuMessageDedupeKey(
      textEvent({ messageId: "om_second", createTime: "1710000000000" }),
    );
    expect(first).toBeDefined();
    expect(retry).toBe(first);
  });

  it("keeps genuine repeat sends distinct via create_time", () => {
    const a = resolveFeishuMessageDedupeKey(
      textEvent({ messageId: "om_a", createTime: "1710000000000" }),
    );
    const b = resolveFeishuMessageDedupeKey(
      textEvent({ messageId: "om_b", createTime: "1710000001000" }),
    );
    expect(a).not.toBe(b);
  });

  it("does not collide across senders, chats, or content", () => {
    const base = textEvent({ messageId: "om_1", createTime: "1710000000000" });
    const otherSender = textEvent({
      messageId: "om_2",
      createTime: "1710000000000",
      senderOpenId: "ou-other",
    });
    const otherChat = textEvent({ messageId: "om_3", createTime: "1710000000000", chatId: "oc-2" });
    const otherText = textEvent({ messageId: "om_4", createTime: "1710000000000", text: "bye" });
    const baseKey = resolveFeishuMessageDedupeKey(base);
    expect(resolveFeishuMessageDedupeKey(otherSender)).not.toBe(baseKey);
    expect(resolveFeishuMessageDedupeKey(otherChat)).not.toBe(baseKey);
    expect(resolveFeishuMessageDedupeKey(otherText)).not.toBe(baseKey);
  });

  it("falls back to message_id for text without a stable retry anchor", () => {
    const key = resolveFeishuMessageDedupeKey(textEvent({ messageId: "om_no_time" }));
    expect(key).toBe("om_no_time");
  });

  it("falls back to message_id for malformed create_time", () => {
    const key = resolveFeishuMessageDedupeKey(
      textEvent({ messageId: "om_bad_time", createTime: "1710000000000ms" }),
    );
    expect(key).toBe("om_bad_time");
  });

  it("keeps media keyed by message_id plus media key", () => {
    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "om_media",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_123" }),
        create_time: "1710000000000",
      },
    };
    expect(resolveFeishuMessageDedupeKey(event)).toBe(
      JSON.stringify(["om_media", "image_key:img_123"]),
    );
  });

  it.each([
    {
      label: "interleaved image and file attachments",
      content: [
        { tag: "media", file_key: "file_first" },
        { tag: "img", image_key: "img_middle" },
        { tag: "media", file_key: "file_last" },
      ],
      expected: ["image_key:img_middle", "file_key:file_first", "file_key:file_last"],
    },
    {
      label: "duplicate occurrences and the same key in both resource types",
      content: [
        { tag: "media", file_key: "shared" },
        { tag: "img", image_key: "shared" },
        { tag: "img", image_key: "shared" },
        { tag: "media", file_key: "shared" },
      ],
      expected: ["image_key:shared", "image_key:shared", "file_key:shared", "file_key:shared"],
    },
    {
      label: "invalid resource keys",
      content: [
        { tag: "img", image_key: "invalid/key" },
        { tag: "media", file_key: "file_valid" },
      ],
      expected: ["file_key:file_valid"],
    },
  ])("preserves the persisted rich-post replay key for $label", ({ content, expected }) => {
    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-user" } },
      message: {
        message_id: "om_post",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({ title: "", content: [content] }),
      },
    };

    expect(resolveFeishuMessageDedupeKey(event)).toBe(JSON.stringify(["om_post", ...expected]));
  });
});
