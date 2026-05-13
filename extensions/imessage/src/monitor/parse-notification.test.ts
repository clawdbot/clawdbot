import { describe, expect, it } from "vitest";
import { parseIMessageNotification } from "./parse-notification.js";

describe("parseIMessageNotification", () => {
  it("strips a length-delimited field wrapper from text and reply_to_text", () => {
    const wrappedText = `${String.fromCharCode(0x0a, 11)}hello world`;
    const wrappedReply = `${String.fromCharCode(0x0a, 5)}quote`;
    const raw = {
      message: {
        id: 1,
        guid: "g",
        chat_id: 2,
        sender: "+10000000000",
        destination_caller_id: null,
        is_from_me: false,
        text: wrappedText,
        reply_to_id: null,
        reply_to_text: wrappedReply,
        reply_to_sender: null,
        created_at: null,
        attachments: null,
        chat_identifier: null,
        chat_guid: null,
        chat_name: null,
        participants: null,
        is_group: false,
      },
    };

    const parsed = parseIMessageNotification(raw);
    expect(parsed?.text).toBe("hello world");
    expect(parsed?.reply_to_text).toBe("quote");
  });

  it("preserves reaction event metadata", () => {
    const parsed = parseIMessageNotification({
      message: {
        id: 1,
        guid: "reaction-guid",
        chat_id: 2,
        sender: "+10000000000",
        destination_caller_id: null,
        is_from_me: false,
        text: "",
        is_reaction: true,
        is_tapback: true,
        associated_message_guid: "p:0/target-guid",
        associated_message_type: 2001,
        reaction_type: "like",
        reaction_emoji: "👍",
        is_reaction_add: true,
        reacted_to_guid: "target-guid",
        attachments: null,
        chat_identifier: null,
        chat_guid: null,
        chat_name: null,
        participants: null,
        is_group: false,
      },
    });

    expect(parsed?.is_reaction).toBe(true);
    expect(parsed?.is_tapback).toBe(true);
    expect(parsed?.associated_message_guid).toBe("p:0/target-guid");
    expect(parsed?.associated_message_type).toBe(2001);
    expect(parsed?.reaction_emoji).toBe("👍");
    expect(parsed?.reacted_to_guid).toBe("target-guid");
  });

  it("accepts iMessage attachment transfer_name and uti metadata", () => {
    const parsed = parseIMessageNotification({
      message: {
        id: 1,
        guid: "link-preview-guid",
        chat_id: 2,
        sender: "+10000000000",
        is_from_me: false,
        text: "https://example.com/article",
        attachments: [
          {
            original_path:
              "/Users/openclaw/Library/Messages/Attachments/AA/BB/link.pluginPayloadAttachment",
            mime_type: null,
            missing: false,
            transfer_name: "link.pluginPayloadAttachment",
            uti: "com.apple.messages.pluginPayloadAttachment",
          },
        ],
        chat_identifier: null,
        chat_guid: null,
        chat_name: null,
        participants: null,
        is_group: false,
      },
    });

    expect(parsed?.attachments?.[0]).toMatchObject({
      transfer_name: "link.pluginPayloadAttachment",
      uti: "com.apple.messages.pluginPayloadAttachment",
    });
  });
});
