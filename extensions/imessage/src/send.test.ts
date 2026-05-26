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

    expect(result.messageId).toBe("p:0/imsg-1");
    expect(result.sentText).toBe("hello");
    expect(result.echoText).toBe("hello");
    expect(result.receipt.primaryPlatformMessageId).toBe("p:0/imsg-1");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/imsg-1"]);
    expect(result.receipt.replyToId).toBe("reply-1");
    expect(result.receipt.raw).toEqual([
      {
        channel: "imessage",
        messageId: "p:0/imsg-1",
        chatId: "42",
        meta: { targetKind: "chat_id" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "p:0/imsg-1",
        kind: "text",
        replyToId: "reply-1",
        raw: {
          channel: "imessage",
          messageId: "p:0/imsg-1",
          chatId: "42",
          meta: { targetKind: "chat_id" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("sends explicit chat media-only payloads through send-attachment auto transport", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "p:0/media-guid", transferGuid: "transfer-1" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/media-guid");
    expect(result.sentText).toBe("");
    expect(result.echoText).toBe("<media:image>");
    expect(result.receipt.primaryPlatformMessageId).toBe("p:0/media-guid");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/media-guid"]);
    expect(client.request).not.toHaveBeenCalled();
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(result.receipt.raw).toEqual([
      {
        channel: "imessage",
        messageId: "p:0/media-guid",
        conversationId: "chat-1",
        meta: { targetKind: "chat_guid" },
      },
    ]);
    expect(result.receipt.parts).toEqual([
      {
        index: 0,
        platformMessageId: "p:0/media-guid",
        kind: "media",
        raw: {
          channel: "imessage",
          messageId: "p:0/media-guid",
          conversationId: "chat-1",
          meta: { targetKind: "chat_guid" },
        },
      },
    ]);
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("resolves chat_id media-only payloads before using send-attachment", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ guid: "any;+;group-guid" })
      .mockResolvedValueOnce({ messageId: "p:0/media-guid" });

    const result = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/media-guid");
    expect(client.request).not.toHaveBeenCalled();
    expect(runCliJson.mock.calls).toEqual([
      [["group", "--chat-id", "42"]],
      [
        [
          "send-attachment",
          "--chat",
          "any;+;group-guid",
          "--file",
          "/tmp/image.png",
          "--transport",
          "auto",
        ],
      ],
    ]);
  });

  it("falls back to the existing rpc send path when send-attachment is unavailable", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockRejectedValueOnce(new Error("unknown command send-attachment"));

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("12345");
    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(client.request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_guid: "chat-1",
        file: "/tmp/image.png",
        text: "",
      }),
      expect.any(Object),
    );
  });

  it("falls back to the existing rpc send path when chat_id lookup is unavailable", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockRejectedValueOnce(new Error("private API bridge unavailable"));

    const result = await sendMessageIMessage("chat_id:42", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("12345");
    expect(runCliJson.mock.calls).toEqual([[["group", "--chat-id", "42"]]]);
    expect(client.request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_id: 42,
        file: "/tmp/image.png",
        text: "",
      }),
      expect.any(Object),
    );
  });

  it("rejects failed send-attachment json instead of reporting success", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: "attachment delivery failed" });

    await expect(
      sendMessageIMessage("chat_guid:chat-1", "", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
      }),
    ).rejects.toThrow("attachment delivery failed");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("keeps DM handle media sends on the existing rpc send path", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn();

    await sendMessageIMessage("+15551234567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(client.request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15551234567",
        file: "/tmp/image.png",
        text: "",
      }),
      expect.any(Object),
    );
  });

  it("preserves literal media placeholder text when no attachment is sent", async () => {
    const client = createClient({ guid: "p:0/imsg-text" });

    const result = await sendMessageIMessage("chat_id:42", "literal <media:image> text", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(result.sentText).toBe("literal <media:image> text");
    expect(result.echoText).toBe("literal <media:image> text");
    expect(client.request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_id: 42,
        text: "literal <media:image> text",
      }),
      expect.any(Object),
    );
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
