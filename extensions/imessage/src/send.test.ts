// Imessage tests cover send plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIMessageApprovalReactionTargetsForTest,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import type { IMessageRpcClient } from "./client.js";
import {
  findLatestIMessageEntryForChat,
  resetIMessageShortIdState,
} from "./monitor-reply-cache.js";
import {
  hasPersistedIMessageEcho,
  resetPersistedIMessageEchoCacheForTest,
} from "./monitor/persisted-echo-cache.js";
import { sendMessageIMessage } from "./send.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

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

function createRejectingClient(error: Error): IMessageRpcClient {
  return {
    request: vi.fn(async () => {
      await Promise.resolve();
      throw error;
    }),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
}

function getClientMocks(client: IMessageRpcClient): {
  request: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return client as unknown as {
    request: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

function createApprovalText(id = "approval-123"): string {
  return [
    "Exec approval required",
    `ID: ${id}`,
    "",
    `Reply with: /approve ${id} allow-once|deny`,
  ].join("\n");
}

describe("sendMessageIMessage receipts", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    resetIMessageShortIdState();
    resetPersistedIMessageEchoCacheForTest();
  });

  afterEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    resetIMessageShortIdState();
    resetPersistedIMessageEchoCacheForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

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
    expect(client["request"]).not.toHaveBeenCalled();
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

  it("sends audioAsVoice media through send-attachment audio transport", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/voice-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/voice-guid");
    expect(runCliJson.mock.calls).toEqual([
      [
        [
          "send-attachment",
          "--chat",
          "chat-1",
          "--file",
          "/tmp/voice.caf",
          "--audio",
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("preserves audioAsVoice media when replying to an iMessage thread", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/threaded-voice-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/voice.caf",
      audioAsVoice: true,
      replyToId: "p:0/reply-guid",
      resolveAttachmentImpl: async () => ({ path: "/tmp/voice.caf", contentType: "audio/x-caf" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/threaded-voice-guid");
    expect(runCliJson.mock.calls).toEqual([
      [
        [
          "send-attachment",
          "--chat",
          "chat-1",
          "--file",
          "/tmp/voice.caf",
          "--audio",
          "--reply-to",
          "p:0/reply-guid",
          "--transport",
          "auto",
        ],
      ],
    ]);
    expect(result.receipt.replyToId).toBe("p:0/reply-guid");
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["voice"]);
    expect(client["request"]).not.toHaveBeenCalled();
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
    expect(client["request"]).not.toHaveBeenCalled();
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
    expect(
      findLatestIMessageEntryForChat({
        accountId: "default",
        chatGuid: "any;+;group-guid",
      }),
    ).toEqual(
      expect.objectContaining({
        messageId: "p:0/media-guid",
        chatGuid: "any;+;group-guid",
        chatId: 42,
        isFromMe: true,
      }),
    );
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
    expect(client["request"]).toHaveBeenCalledWith(
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
    expect(client["request"]).toHaveBeenCalledWith(
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
    expect(client["request"]).not.toHaveBeenCalled();
  });

  it("routes DM handle media-only sends through send-attachment", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    const result = await sendMessageIMessage("+15550004567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/dm-media-guid");
    expect(runCliJson).toHaveBeenCalledTimes(1);
    const attachmentArgs = runCliJson.mock.calls[0]?.[0] as string[];
    expect(attachmentArgs[0]).toBe("send-attachment");
    expect(attachmentArgs[1]).toBe("--chat");
    expect(attachmentArgs[2]).toBe("any;-;+15550004567");
    expect(attachmentArgs.slice(3)).toEqual(["--file", "/tmp/image.png", "--transport", "auto"]);
    const cachedEntry = findLatestIMessageEntryForChat({
      accountId: "default",
      chatIdentifier: "any;-;+15550004567",
    });
    expect(cachedEntry).toEqual(
      expect.objectContaining({
        messageId: "p:0/dm-media-guid",
        chatIdentifier: "any;-;+15550004567",
        isFromMe: true,
      }),
    );
    expect(cachedEntry).not.toHaveProperty("chatGuid");
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("preserves explicit SMS service for bare-handle media sends", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/sms-media-guid" });

    await sendMessageIMessage("+15550004567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      service: "sms",
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson.mock.calls[0]?.[0]).toEqual([
      "send-attachment",
      "--chat",
      "SMS;-;+15550004567",
      "--file",
      "/tmp/image.png",
      "--transport",
      "auto",
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("preserves configured iMessage service for bare-handle media sends", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/imessage-media-guid" });

    await sendMessageIMessage("+15550004567", "", {
      config: {
        channels: {
          imessage: {
            accounts: {
              default: {
                service: "imessage",
              },
            },
          },
        },
      },
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson.mock.calls[0]?.[0]).toEqual([
      "send-attachment",
      "--chat",
      "iMessage;-;+15550004567",
      "--file",
      "/tmp/image.png",
      "--transport",
      "auto",
    ]);
    expect(getClientMocks(client).request).not.toHaveBeenCalled();
  });

  it("keeps national-format phone media sends on the region-aware RPC path", async () => {
    const client = createClient({ guid: "p:0/media-guid" });
    const runCliJson = vi.fn();

    const result = await sendMessageIMessage("555-000-4567", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      region: "US",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        file: "/tmp/image.png",
        region: "US",
        to: "555-000-4567",
      }),
      expect.any(Object),
    );
    expect(result.messageId).toBe("p:0/media-guid");
  });

  it("keeps chat_identifier media sends on the rpc send path", async () => {
    const client = createClient({ message_id: 12345 });
    const runCliJson = vi.fn();

    await sendMessageIMessage("chat_identifier:team-thread", "", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).not.toHaveBeenCalled();
    expect(client["request"]).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_identifier: "team-thread",
        file: "/tmp/image.png",
      }),
      expect.any(Object),
    );
  });

  it("sends DM handle media captions as attachment plus follow-up text", async () => {
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    const result = await sendMessageIMessage("imessage:+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson).toHaveBeenCalledTimes(1);
    const captionAttachmentArgs = runCliJson.mock.calls[0]?.[0] as string[];
    expect(captionAttachmentArgs[0]).toBe("send-attachment");
    expect(captionAttachmentArgs[1]).toBe("--chat");
    expect(captionAttachmentArgs[2]).toBe("iMessage;-;+15550004567");
    expect(captionAttachmentArgs.slice(3)).toEqual([
      "--file",
      "/tmp/image.png",
      "--transport",
      "auto",
    ]);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        text: "caption",
      }),
      expect.any(Object),
    );
    expect(result.sentText).toBe("caption");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/dm-media-guid", "p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("does not persist caption text when the caption follow-up send fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imessage-send-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const client = createRejectingClient(new Error("caption failed"));
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    await expect(
      sendMessageIMessage("imessage:+15550004567", "caption", {
        config: IMESSAGE_TEST_CFG,
        client,
        mediaUrl: "/tmp/image.png",
        resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
        runCliJson,
      }),
    ).rejects.toThrow("caption failed");

    const scope = "default:imessage:+15550004567";
    expect(hasPersistedIMessageEcho({ scope, text: "caption" })).toBe(false);
    expect(hasPersistedIMessageEcho({ scope, text: "<media:image>" })).toBe(true);
    expect(hasPersistedIMessageEcho({ scope, messageId: "p:0/dm-media-guid" })).toBe(true);
  });

  it("returns the caption message id when captioned attachment only has a placeholder id", async () => {
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ success: true });

    const result = await sendMessageIMessage("+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(result.messageId).toBe("p:0/caption-guid");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["text"]);
  });

  it("sends explicit chat media captions as attachment plus follow-up text", async () => {
    const client = createClient({ guid: "p:0/caption-guid" });
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/chat-media-guid" });

    const result = await sendMessageIMessage("chat_guid:chat-1", "caption", {
      config: IMESSAGE_TEST_CFG,
      client,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(runCliJson.mock.calls).toEqual([
      [["send-attachment", "--chat", "chat-1", "--file", "/tmp/image.png", "--transport", "auto"]],
    ]);
    expect(getClientMocks(client).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        chat_guid: "chat-1",
        text: "caption",
      }),
      expect.any(Object),
    );
    expect(result.sentText).toBe("caption");
    expect(result.receipt.platformMessageIds).toEqual(["p:0/chat-media-guid", "p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("closes created caption follow-up clients when no caller client is supplied", async () => {
    const createdClient = createClient({ guid: "p:0/caption-guid" });
    const createClientImpl = vi.fn(async () => createdClient);
    const runCliJson = vi.fn().mockResolvedValueOnce({ messageId: "p:0/dm-media-guid" });

    const result = await sendMessageIMessage("+15550004567", "caption", {
      config: IMESSAGE_TEST_CFG,
      createClient: createClientImpl,
      mediaUrl: "/tmp/image.png",
      resolveAttachmentImpl: async () => ({ path: "/tmp/image.png", contentType: "image/png" }),
      runCliJson,
    });

    expect(createClientImpl).toHaveBeenCalledTimes(1);
    expect(getClientMocks(createdClient).request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        to: "+15550004567",
        text: "caption",
      }),
      expect.any(Object),
    );
    expect(getClientMocks(createdClient).stop).toHaveBeenCalledOnce();
    expect(result.receipt.platformMessageIds).toEqual(["p:0/dm-media-guid", "p:0/caption-guid"]);
    expect(result.receipt.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it("preserves literal media placeholder text when no attachment is sent", async () => {
    const client = createClient({ guid: "p:0/imsg-text" });

    const result = await sendMessageIMessage("chat_id:42", "literal <media:image> text", {
      config: IMESSAGE_TEST_CFG,
      client,
    });

    expect(result.sentText).toBe("literal <media:image> text");
    expect(result.echoText).toBe("literal <media:image> text");
    expect(client["request"]).toHaveBeenCalledWith(
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

  it("resolves numeric chat.db ROWIDs to GUIDs for approval reaction binding", async () => {
    const client = createClient({ message_id: 12345 });
    const resolveMessageGuidImpl = vi.fn(async () => "p:0/resolved-guid");

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveMessageGuidImpl,
    });

    expect(result.messageId).toBe("12345");
    expect(result.guid).toBe("p:0/resolved-guid");
    expect(resolveMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      messageId: "12345",
    });
  });

  it("does not resolve chat.db GUIDs when the bridge already returned a GUID", async () => {
    const client = createClient({ guid: "p:0/native-guid" });
    const resolveMessageGuidImpl = vi.fn(async () => "p:0/resolved-guid");

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/native-guid");
    expect(result.guid).toBe("p:0/native-guid");
    expect(resolveMessageGuidImpl).not.toHaveBeenCalled();
  });

  it("leaves reaction binding unset when numeric ROWID cannot be resolved", async () => {
    const client = createClient({ message_id: 12345 });
    const resolveMessageGuidImpl = vi.fn(async () => null);

    const result = await sendMessageIMessage("chat_id:42", "hello", {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveMessageGuidImpl,
    });

    expect(result.messageId).toBe("12345");
    expect(result.guid).toBeUndefined();
  });

  it("recovers approval prompt GUID without resending when rpc send times out", async () => {
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const createClientLocal = vi.fn(async () => client);
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/fallback-guid");
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      createClient: createClientLocal,
      runCliJson,
      service: "sms",
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/fallback-guid");
    expect(result.guid).toBe("p:0/fallback-guid");
    expect(client["stop"]).toHaveBeenCalledOnce();
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-123"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("uses the default local chat.db path for timeout GUID recovery", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/default-db-guid");
    const approvalText = createApprovalText("approval-default");

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      runCliJson,
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/default-db-guid");
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-default"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("uses the default local chat.db path for Homebrew imsg paths", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/homebrew-guid");
    const approvalText = createApprovalText("approval-homebrew");

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      cliPath: "/opt/homebrew/bin/imsg",
      runCliJson,
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/homebrew-guid");
    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-homebrew"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not use the local default chat.db path for custom cliPath wrappers", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const approvalText = createApprovalText("approval-remote");
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(6_001);

    await expect(
      sendMessageIMessage("chat_id:42", approvalText, {
        config: {
          channels: {
            imessage: {
              accounts: {
                default: {
                  remoteHost: "bot@gateway-host",
                },
              },
            },
          },
        },
        client,
        cliPath: "/Users/me/.openclaw/scripts/imsg",
        runCliJson,
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: undefined,
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-remote"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not use the local default chat.db path for auto-detected ssh wrappers", async () => {
    vi.stubEnv("HOME", "/Users/me");
    const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-wrapper-"));
    const wrapperPath = path.join(wrapperDir, "imsg");
    fs.writeFileSync(wrapperPath, '#!/bin/sh\nexec ssh -T gateway-host imsg "$@"\n');
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const approvalText = createApprovalText("approval-ssh-wrapper");
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(6_001);

    try {
      await expect(
        sendMessageIMessage("chat_id:42", approvalText, {
          config: IMESSAGE_TEST_CFG,
          client,
          cliPath: wrapperPath,
          runCliJson,
          resolveSentMessageGuidImpl,
        }),
      ).rejects.toThrow("imsg rpc timeout (send)");
    } finally {
      fs.rmSync(wrapperDir, { recursive: true, force: true });
    }

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: undefined,
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-ssh-wrapper"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("throws the rpc timeout without resending for generic text", async () => {
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/stale-guid");

    await expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).not.toHaveBeenCalled();
  });

  it("throws the rpc timeout without resending when approval GUID recovery misses", async () => {
    const client = createRejectingClient(new Error("imsg rpc timeout (send)"));
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => null);
    const approvalText = createApprovalText();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(6_001);

    await expect(
      sendMessageIMessage("chat_id:42", approvalText, {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
        dbPath: "/Users/me/Library/Messages/chat.db",
        resolveSentMessageGuidImpl,
      }),
    ).rejects.toThrow("imsg rpc timeout (send)");

    expect(runCliJson).not.toHaveBeenCalled();
    expect(resolveSentMessageGuidImpl).toHaveBeenCalled();
  });

  it("recovers a GUID for approval prompts when rpc send returns only sent status", async () => {
    const client = createClient({ status: "sent" });
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/recovered-guid");
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("ok");
    expect(result.guid).toBe("p:0/recovered-guid");
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { chatId: 42 },
        messageId: "p:0/recovered-guid",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "approval-123",
      decision: "allow-once",
    });
    expect(resolveSentMessageGuidImpl).toHaveBeenCalledWith({
      dbPath: "/Users/me/Library/Messages/chat.db",
      target: expect.objectContaining({ kind: "chat_id", chatId: 42 }),
      text: expect.stringContaining("ID: approval-123"),
      sentAfterMs: expect.any(Number),
    });
  });

  it("does not poll for approval prompt GUIDs when chat.db is unavailable", async () => {
    const client = createClient({ status: "sent" });
    const approvalText = createApprovalText();
    const startedAt = performance.now();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      client,
      dbPath: "/path/to/missing/chat.db",
    });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(result.messageId).toBe("ok");
    expect(result.guid).toBeUndefined();
  });

  it("does not use one-shot imsg fallback for non-timeout rpc send errors", async () => {
    const client = createRejectingClient(new Error("imsg rpc error (send)"));
    const runCliJson = vi.fn();

    await expect(
      sendMessageIMessage("chat_id:42", "hello", {
        config: IMESSAGE_TEST_CFG,
        client,
        runCliJson,
      }),
    ).rejects.toThrow("imsg rpc error (send)");

    expect(runCliJson).not.toHaveBeenCalled();
  });
});
