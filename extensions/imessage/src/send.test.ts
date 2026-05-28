import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearIMessageApprovalReactionTargetsForTest,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
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

function createRejectingClient(error: Error): IMessageRpcClient {
  return {
    request: vi.fn(async () => {
      throw error;
    }),
    stop: vi.fn(async () => {}),
  } as unknown as IMessageRpcClient;
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
  afterEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    vi.unstubAllEnvs();
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
    const createClient = vi.fn(async () => client);
    const runCliJson = vi.fn();
    const resolveSentMessageGuidImpl = vi.fn(async () => "p:0/fallback-guid");
    const approvalText = createApprovalText();

    const result = await sendMessageIMessage("chat_id:42", approvalText, {
      config: IMESSAGE_TEST_CFG,
      createClient,
      runCliJson,
      service: "sms",
      dbPath: "/Users/me/Library/Messages/chat.db",
      resolveSentMessageGuidImpl,
    });

    expect(result.messageId).toBe("p:0/fallback-guid");
    expect(result.guid).toBe("p:0/fallback-guid");
    expect(client.stop).toHaveBeenCalledOnce();
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
