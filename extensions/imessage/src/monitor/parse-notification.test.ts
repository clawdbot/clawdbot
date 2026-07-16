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
});
