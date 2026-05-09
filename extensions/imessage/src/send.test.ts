import { describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { sendMessageIMessage } from "./send.js";

const IMESSAGE_TEST_CFG = {
  channels: {
    imessage: {
      accounts: {
        default: {},
      },
    },
  },
};

function createClient(result: Record<string, unknown>): IMessageRpcClient {
  return {
    request: vi.fn(async () => result),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

describe("sendMessageIMessage receipts", () => {
  it("attaches a text receipt for native send ids", async () => {
    const client = createClient({ guid: "p:0/imsg-1" });

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      replyToId: "reply-1",
    });

    expect(result).toMatchObject({
      messageId: "p:0/imsg-1",
      sentText: "hello",
      receipt: {
        primaryPlatformMessageId: "p:0/imsg-1",
        platformMessageIds: ["p:0/imsg-1"],
        replyToId: "reply-1",
        parts: [
          expect.objectContaining({
            platformMessageId: "p:0/imsg-1",
            kind: "text",
            replyToId: "reply-1",
            raw: expect.objectContaining({
              channel: "imessage",
              chatId: "42",
            }),
          }),
        ],
      },
    });
  });

  it("attaches a media receipt after attachment resolution", async () => {
    const client = createClient({ message_id: 12345 });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
    });

    expect(result).toMatchObject({
      messageId: "12345",
      sentText: "<media:image>",
      receipt: {
        primaryPlatformMessageId: "12345",
        platformMessageIds: ["12345"],
        parts: [
          expect.objectContaining({
            platformMessageId: "12345",
            kind: "media",
            raw: expect.objectContaining({
              conversationId: "chat-1",
            }),
          }),
        ],
      },
    });
  });

  it("does not treat compatibility ok responses as visible platform ids", async () => {
    const client = createClient({ ok: "true" });

    const result = await sendMessageIMessage("+15551234567", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(result.messageId).toBe("ok");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });
});
