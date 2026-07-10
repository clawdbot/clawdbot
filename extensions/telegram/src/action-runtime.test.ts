// Telegram tests cover action runtime plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramAction, telegramActionRuntime } from "./action-runtime.js";
import { beginTelegramInboundEventDeliveryCorrelation } from "./inbound-event-delivery.js";
import {
  getTopicName,
  resetTopicNameCacheForTest,
  resolveTopicNameCacheScope,
  setTelegramTopicNameStoreFactoryForTest,
} from "./topic-name-cache.js";

const originalTelegramActionRuntime = { ...telegramActionRuntime };
const reactMessageTelegram = vi.fn(async () => ({ ok: true }));
const sendMessageTelegram = vi.fn(
  async (_to: string, _text: string, _opts?: Record<string, unknown>) => ({
    messageId: "789",
    chatId: "123",
  }),
);
const sendDurableMessageBatch = vi.fn(
  async (params: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string;
    payloads: Array<{
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      audioAsVoice?: boolean;
      delivery?: {
        pin?: true | { enabled?: boolean; notify?: boolean; required?: boolean };
      };
      channelData?: { telegram?: { buttons?: unknown; quoteText?: string } };
    }>;
    replyToId?: string;
    threadId?: string | number;
    forceDocument?: boolean;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
    session?: {
      key?: string;
      agentId?: string;
      requesterAccountId?: string;
    };
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
  }) => {
    const payload = params.payloads[0] ?? {};
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const telegramData = payload.channelData?.telegram;
    const cfg = params.cfg as {
      channels?: {
        telegram?: {
          botToken?: string;
          accounts?: Record<string, { botToken?: string }>;
        };
      };
    };
    const token =
      (params.accountId
        ? cfg.channels?.telegram?.accounts?.[params.accountId]?.botToken
        : undefined) ??
      cfg.channels?.telegram?.botToken ??
      process.env.TELEGRAM_BOT_TOKEN;
    const baseOptions = {
      cfg: params.cfg,
      token,
      accountId: params.accountId,
      gatewayClientScopes: params.gatewayClientScopes,
      replyToMessageId:
        params.replyToId == null ? undefined : Number.parseInt(params.replyToId, 10),
      messageThreadId:
        params.threadId == null ? undefined : Number.parseInt(String(params.threadId), 10),
      quoteText: telegramData?.quoteText,
      asVoice: payload.audioAsVoice,
      silent: params.silent,
      forceDocument: params.forceDocument,
      mediaLocalRoots: params.mediaAccess?.localRoots,
      mediaReadFile: params.mediaAccess?.readFile,
    };
    const calls = mediaUrls.length > 0 ? mediaUrls : [undefined];
    let last = { messageId: "789", chatId: "123" };
    for (const [index, mediaUrl] of calls.entries()) {
      last = await sendMessageTelegram(params.to, index === 0 ? (payload.text ?? "") : "", {
        ...baseOptions,
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(index === 0 && telegramData?.buttons ? { buttons: telegramData.buttons } : {}),
      });
    }
    const pin =
      payload.delivery?.pin === true
        ? { enabled: true }
        : payload.delivery?.pin && payload.delivery.pin.enabled
          ? payload.delivery.pin
          : undefined;
    if (pin && last.messageId) {
      try {
        await pinMessageTelegram(params.to, last.messageId, {
          cfg: params.cfg,
          accountId: params.accountId,
          notify: pin.notify,
          verbose: false,
          gatewayClientScopes: params.gatewayClientScopes,
        });
      } catch (err) {
        if (pin.required) {
          throw err;
        }
      }
    }
    return {
      status: "sent",
      results: [{ channel: "telegram", messageId: last.messageId, chatId: last.chatId }],
      receipt: {
        primaryPlatformMessageId: last.messageId,
        platformMessageIds: [last.messageId],
        parts: [
          {
            platformMessageId: last.messageId,
            kind: mediaUrls.length > 0 ? "media" : "text",
            index: 0,
          },
        ],
        sentAt: Date.now(),
      },
    } as const;
  },
);
const sendPollTelegram = vi.fn(async () => ({
  messageId: "790",
  chatId: "123",
  pollId: "poll-1",
}));
const sendStickerTelegram = vi.fn(async () => ({
  messageId: "456",
  chatId: "123",
}));
const deleteMessageTelegram = vi.fn(async () => ({ ok: true }));
const editMessageTelegram = vi.fn(async () => ({
  ok: true,
  messageId: "456",
  chatId: "123",
}));
const editMessageReplyMarkupTelegram = vi.fn(async () => ({
  ok: true,
  messageId: "456",
  chatId: "123",
}));
const editForumTopicTelegram = vi.fn(async () => ({
  ok: true,
  chatId: "123",
  messageThreadId: 42,
  name: "Renamed",
}));
const pinMessageTelegram = vi.fn(
  async (_to: string, _messageId: string, _opts?: Record<string, unknown>) => ({
    ok: true,
    messageId: "789",
    chatId: "123",
  }),
);
const createForumTopicTelegram = vi.fn(async () => ({
  topicId: 99,
  name: "Topic",
  chatId: "123",
}));
let envSnapshot: ReturnType<typeof captureEnv>;

type TopicNameEntryForTest = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

const topicNameStoresForTest = new Map<string, Map<string, TopicNameEntryForTest>>();

function installTopicNameStoreForTest() {
  topicNameStoresForTest.clear();
  setTelegramTopicNameStoreFactoryForTest((namespace) => {
    const entries = topicNameStoresForTest.get(namespace) ?? new Map();
    topicNameStoresForTest.set(namespace, entries);
    return {
      async register(key, value) {
        entries.set(key, value);
      },
      async entries() {
        return Array.from(entries, ([key, value]) => ({ key, value }));
      },
      async delete(key) {
        return entries.delete(key);
      },
      async clear() {
        entries.clear();
      },
    };
  });
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function mockCall(source: MockCallSource, callIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected Telegram mock call: ${label}`);
  }
  return call;
}

function resultDetails(result: Awaited<ReturnType<typeof handleTelegramAction>>) {
  return requireRecord(result.details, "Telegram action details");
}

describe("handleTelegramAction", () => {
  const defaultReactionAction = {
    action: "react",
    chatId: "123",
    messageId: "456",
    emoji: "✅",
  } as const;

  function reactionConfig(reactionLevel: "minimal" | "extensive" | "off" | "ack"): OpenClawConfig {
    return {
      channels: { telegram: { botToken: "tok", reactionLevel } },
    } as OpenClawConfig;
  }

  function telegramConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return {
      channels: {
        telegram: {
          botToken: "tok",
          ...overrides,
        },
      },
    } as OpenClawConfig;
  }

  function topicCacheScopeFor(cfg: OpenClawConfig, accountId: string): string {
    return resolveTopicNameCacheScope(resolveStorePath(cfg.session?.store, { agentId: accountId }));
  }

  async function sendInlineButtonsMessage(params: {
    to: string;
    buttons: Array<Array<{ text: string; callback_data: string; style?: string }>>;
    inlineButtons: "dm" | "group" | "all";
  }) {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: params.to,
        content: "Choose",
        presentation: {
          blocks: params.buttons.map((row) => ({
            type: "buttons",
            buttons: row.map((button) => ({
              label: button.text,
              value: button.callback_data,
              style: button.style,
            })),
          })),
        },
      },
      telegramConfig({ capabilities: { inlineButtons: params.inlineButtons } }),
    );
  }

  async function expectReactionAdded(reactionLevel: "minimal" | "extensive") {
    await handleTelegramAction(defaultReactionAction, reactionConfig(reactionLevel));
    const call = mockCall(reactMessageTelegram, 0, "reaction add");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe(456);
    expect(call[2]).toBe("✅");
    const options = requireRecord(call[3], "reaction add options");
    expect(options.token).toBe("tok");
    expect(options.remove).toBe(false);
  }

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "TELEGRAM_BOT_TOKEN"]);
    resetTopicNameCacheForTest();
    installTopicNameStoreForTest();
    Object.assign(telegramActionRuntime, originalTelegramActionRuntime, {
      reactMessageTelegram,
      sendDurableMessageBatch,
      sendMessageTelegram,
      sendPollTelegram,
      sendStickerTelegram,
      deleteMessageTelegram,
      editMessageTelegram,
      editMessageReplyMarkupTelegram,
      editForumTopicTelegram,
      pinMessageTelegram,
      createForumTopicTelegram,
    });
    reactMessageTelegram.mockClear();
    sendDurableMessageBatch.mockClear();
    sendMessageTelegram.mockClear();
    sendPollTelegram.mockClear();
    sendStickerTelegram.mockClear();
    deleteMessageTelegram.mockClear();
    editMessageTelegram.mockClear();
    editMessageReplyMarkupTelegram.mockClear();
    editForumTopicTelegram.mockClear();
    pinMessageTelegram.mockClear();
    createForumTopicTelegram.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = "tok";
  });

  afterEach(() => {
    setTelegramTopicNameStoreFactoryForTest(undefined);
    resetTopicNameCacheForTest();
    topicNameStoresForTest.clear();
    envSnapshot.restore();
  });

  it("adds reactions when reactionLevel is minimal", async () => {
    await expectReactionAdded("minimal");
  });

  it("routes omitted-account action tokens through the configured defaultAccount (#61012)", async () => {
    const cfg = {
      channels: {
        telegram: {
          reactionLevel: "minimal",
          defaultAccount: "kitt",
          accounts: {
            kitt: { botToken: "tok-kitt" },
          },
        },
      },
    } as OpenClawConfig;
    await handleTelegramAction(defaultReactionAction, cfg);
    const call = mockCall(reactMessageTelegram, 0, "reaction add");
    const options = requireRecord(call[3], "reaction add options");
    expect(options.token).toBe("tok-kitt");
  });

  it("surfaces non-fatal reaction warnings", async () => {
    reactMessageTelegram.mockResolvedValueOnce({
      ok: false,
      warning: "Reaction unavailable: ✅",
    } as unknown as Awaited<ReturnType<typeof reactMessageTelegram>>);
    const result = await handleTelegramAction(defaultReactionAction, reactionConfig("minimal"));
    const textPayload = result.content.find((item) => item.type === "text");
    expect(textPayload?.type).toBe("text");
    const parsed = JSON.parse((textPayload as { type: "text"; text: string }).text) as {
      ok: boolean;
      warning?: string;
      added?: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.warning).toBe("Reaction unavailable: ✅");
    expect(parsed.added).toBe("✅");
  });

  it("adds reactions when reactionLevel is extensive", async () => {
    await expectReactionAdded("extensive");
  });

  it("accepts snake_case message_id for reactions", async () => {
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        message_id: "456",
        emoji: "✅",
      },
      reactionConfig("minimal"),
    );
    const call = mockCall(reactMessageTelegram, 0, "snake_case reaction");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe(456);
    expect(call[2]).toBe("✅");
    const options = requireRecord(call[3], "snake_case reaction options");
    expect(options.token).toBe("tok");
    expect(options.remove).toBe(false);
  });

  it("soft-fails when messageId is missing", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "minimal" } },
    } as OpenClawConfig;
    const result = await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        emoji: "✅",
      },
      cfg,
    );
    const details = resultDetails(result);
    expect(details.ok).toBe(false);
    expect(details.reason).toBe("missing_message_id");
    expect(reactMessageTelegram).not.toHaveBeenCalled();
  });

  it("soft-fails fractional reaction message ids", async () => {
    const result = await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: 456.5,
        emoji: "✅",
      },
      reactionConfig("minimal"),
    );

    expect(resultDetails(result)).toMatchObject({
      ok: false,
      reason: "missing_message_id",
    });
    expect(reactMessageTelegram).not.toHaveBeenCalled();
  });

  it("removes reactions on empty emoji", async () => {
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "",
      },
      reactionConfig("minimal"),
    );
    const call = mockCall(reactMessageTelegram, 0, "empty reaction");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe(456);
    expect(call[2]).toBe("");
    const options = requireRecord(call[3], "empty reaction options");
    expect(options.token).toBe("tok");
    expect(options.remove).toBe(false);
  });

  it("rejects sticker actions when disabled by default", async () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendSticker",
          to: "123",
          fileId: "sticker",
        },
        cfg,
      ),
    ).rejects.toThrow(/sticker actions are disabled/i);
    expect(sendStickerTelegram).not.toHaveBeenCalled();
  });

  it("sends stickers when enabled", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { sticker: true } } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "sendSticker",
        to: "123",
        fileId: "sticker",
      },
      cfg,
    );
    const call = mockCall(sendStickerTelegram, 0, "send sticker");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe("sticker");
    expect(requireRecord(call[2], "send sticker options").token).toBe("tok");
  });

  it("accepts shared sticker action aliases", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { sticker: true } } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "sticker",
        target: "123",
        stickerId: ["sticker"],
        replyTo: 9,
        threadId: 11,
      },
      cfg,
    );
    const call = mockCall(sendStickerTelegram, 0, "sticker alias");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe("sticker");
    const options = requireRecord(call[2], "sticker alias options");
    expect(options.token).toBe("tok");
    expect(options.replyToMessageId).toBe(9);
    expect(options.messageThreadId).toBe(11);
  });

  it("treats null primary id aliases as absent", async () => {
    await handleTelegramAction(
      {
        action: "sendSticker",
        to: "123",
        fileId: "sticker",
        replyToMessageId: null,
        replyTo: 9,
        messageThreadId: null,
        threadId: 11,
      },
      telegramConfig({ actions: { sticker: true } }),
    );
    const call = mockCall(sendStickerTelegram, 0, "sticker null aliases");
    const options = requireRecord(call[2], "sticker null alias options");
    expect(options.replyToMessageId).toBe(9);
    expect(options.messageThreadId).toBe(11);
  });

  it("rejects fractional Telegram thread and reply ids before sending", async () => {
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "123",
          content: "hello",
          replyToMessageId: 9.5,
        },
        telegramConfig(),
      ),
    ).rejects.toThrow("replyToMessageId must be a positive integer.");
    await expect(
      handleTelegramAction(
        {
          action: "sendSticker",
          to: "123",
          fileId: "sticker",
          threadId: 11.5,
        },
        telegramConfig({ actions: { sticker: true } }),
      ),
    ).rejects.toThrow("threadId must be a positive integer.");
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    expect(sendStickerTelegram).not.toHaveBeenCalled();
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = reactionConfig("extensive");
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    const call = mockCall(reactMessageTelegram, 0, "reaction remove");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe(456);
    expect(call[2]).toBe("✅");
    const options = requireRecord(call[3], "reaction remove options");
    expect(options.token).toBe("tok");
    expect(options.remove).toBe(true);
  });

  it.each(["off", "ack"] as const)(
    "soft-fails reactions when reactionLevel is %s",
    async (level) => {
      const result = await handleTelegramAction(
        {
          action: "react",
          chatId: "123",
          messageId: "456",
          emoji: "✅",
        },
        reactionConfig(level),
      );
      const details = resultDetails(result);
      expect(details.ok).toBe(false);
      expect(details.reason).toBe("disabled");
    },
  );

  it("soft-fails when reactions are disabled via actions.reactions", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          reactionLevel: "minimal",
          actions: { reactions: false },
        },
      },
    } as OpenClawConfig;
    const result = await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "✅",
      },
      cfg,
    );
    const details = resultDetails(result);
    expect(details.ok).toBe(false);
    expect(details.reason).toBe("disabled");
  });

  it("sends a text message", async () => {
    const result = await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello, Telegram!",
      },
      telegramConfig(),
      {
        gatewayClientScopes: ["operator.write"],
        sessionKey: "agent:main:telegram:direct:123",
      },
    );
    const call = mockCall(sendMessageTelegram, 0, "text message");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Hello, Telegram!");
    const options = requireRecord(call[2], "text message options");
    expect(options.token).toBe("tok");
    expect(options.mediaUrl).toBeUndefined();
    const durableCall = mockCall(sendDurableMessageBatch, 0, "durable text message");
    expect(requireRecord(durableCall[0], "durable text message params")).toMatchObject({
      channel: "telegram",
      to: "@testchannel",
      durability: "required",
      gatewayClientScopes: ["operator.write"],
      session: { key: "agent:main:telegram:direct:123", agentId: "main" },
      payloads: [{ text: "Hello, Telegram!" }],
    });
    expect(result.content).toStrictEqual([
      {
        type: "text",
        text: '{\n  "ok": true,\n  "messageId": "789",\n  "chatId": "123"\n}',
      },
    ]);
    expect(result.details).toStrictEqual({
      ok: true,
      messageId: "789",
      chatId: "123",
    });
  });

  it("persists sendMessage action deliveries before Telegram platform send", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-action-durable-"));
    const {
      createOutboundTestPlugin,
      createTestRegistry,
      readQueuedDeliveryEntriesForTest,
      setActivePluginRegistry,
    } = await import("openclaw/plugin-sdk/plugin-test-runtime");
    const readDurableQueueEntries = () => readQueuedDeliveryEntriesForTest(stateDir);
    const sendText = vi
      .fn()
      .mockImplementationOnce(async () => {
        const entries = readDurableQueueEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          channel: "telegram",
          to: "12345",
          payloads: [
            {
              text: "times out after queue write",
              delivery: { pin: { enabled: true, required: true } },
            },
          ],
          session: { key: "agent:main:telegram:direct:12345", agentId: "main" },
          gatewayClientScopes: ["operator.write"],
          retryCount: 0,
        });
        throw new Error("telegram timeout");
      })
      .mockImplementationOnce(async () => {
        const entries = readDurableQueueEntries();
        const liveEntry = entries.find((entry) =>
          JSON.stringify(entry.payloads).includes("delivers after queue write"),
        );
        expect(liveEntry).toMatchObject({
          channel: "telegram",
          to: "12345",
          payloads: [{ text: "delivers after queue write" }],
          retryCount: 0,
        });
        return { channel: "telegram", messageId: "tg-ok" };
      });

    process.env.OPENCLAW_STATE_DIR = stateDir;
    telegramActionRuntime.sendDurableMessageBatch =
      originalTelegramActionRuntime.sendDurableMessageBatch;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              deliveryCapabilities: {
                durableFinal: {
                  text: true,
                  media: true,
                  payload: true,
                  silent: true,
                  replyTo: true,
                  thread: true,
                  messageSendingHooks: true,
                  batch: true,
                },
              },
              sendText,
            },
          }),
        },
      ]),
    );

    try {
      await expect(
        handleTelegramAction(
          {
            action: "sendMessage",
            to: "12345",
            content: "times out after queue write",
            delivery: { pin: { enabled: true, required: true } },
          },
          telegramConfig(),
          {
            gatewayClientScopes: ["operator.write"],
            sessionKey: "agent:main:telegram:direct:12345",
          },
        ),
      ).rejects.toThrow("telegram timeout");

      const retryableEntries = readDurableQueueEntries();
      expect(retryableEntries).toHaveLength(1);
      expect(retryableEntries[0]).toMatchObject({
        payloads: [
          {
            text: "times out after queue write",
            delivery: { pin: { enabled: true, required: true } },
          },
        ],
        retryCount: 1,
      });
      expect(String(retryableEntries[0]?.lastError)).toContain("telegram timeout");

      const result = await handleTelegramAction(
        {
          action: "sendMessage",
          to: "12345",
          content: "delivers after queue write",
        },
        telegramConfig(),
        { sessionKey: "agent:main:telegram:direct:12345" },
      );

      expect(result.details).toMatchObject({
        ok: true,
        messageId: "tg-ok",
      });
      expect(readDurableQueueEntries()).toHaveLength(1);
      expect(readDurableQueueEntries()[0]).toMatchObject({
        payloads: [
          {
            text: "times out after queue write",
            delivery: { pin: { enabled: true, required: true } },
          },
        ],
        retryCount: 1,
      });
    } finally {
      setActivePluginRegistry(createTestRegistry([]));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("normalizes legacy group targets for sendMessage actions", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "group:-1001234567890:topic:77",
        content: "Recovered",
      },
      telegramConfig(),
    );

    const call = mockCall(sendMessageTelegram, 0, "legacy group target");
    expect(call[0]).toBe("-1001234567890:topic:77");
    expect(call[1]).toBe("Recovered");
  });

  it("marks the matching inbound event delivered after a successful send", async () => {
    let count = 0;
    const end = beginTelegramInboundEventDeliveryCorrelation("telegram-session", {
      outboundTo: "@testchannel",
      markInboundEventDelivered: () => {
        count += 1;
      },
    });
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello, Telegram!",
      },
      telegramConfig(),
      { sessionKey: "telegram-session" },
    );
    expect(count).toBe(1);
    end();
  });

  it("marks room-event delivery correlations separately", async () => {
    let roomEventCount = 0;
    let userRequestCount = 0;
    const endRoomEvent = beginTelegramInboundEventDeliveryCorrelation(
      "telegram-session",
      {
        outboundTo: "@testchannel",
        markInboundEventDelivered: () => {
          roomEventCount += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );
    const endUserRequest = beginTelegramInboundEventDeliveryCorrelation("telegram-session", {
      outboundTo: "@testchannel",
      markInboundEventDelivered: () => {
        userRequestCount += 1;
      },
    });

    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello from a room event",
      },
      telegramConfig(),
      { sessionKey: "telegram-session", inboundEventKind: "room_event" },
    );

    expect(roomEventCount).toBe(1);
    expect(userRequestCount).toBe(0);
    endRoomEvent();
    endUserRequest();
  });

  it("marks topic room-event delivery when send uses a separate thread id", async () => {
    let count = 0;
    const end = beginTelegramInboundEventDeliveryCorrelation(
      "telegram-session",
      {
        outboundTo: "-100123:topic:77",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "-100123",
        threadId: 77,
        content: "Hello from a room event topic",
      },
      telegramConfig(),
      { sessionKey: "telegram-session", inboundEventKind: "room_event" },
    );

    expect(count).toBe(1);
    end();
  });

  it("marks topic room-event delivery when send uses topic shorthand", async () => {
    let count = 0;
    const end = beginTelegramInboundEventDeliveryCorrelation(
      "telegram-session",
      {
        outboundTo: "-100123:topic:77",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "-100123:77",
        content: "Hello from a room event topic",
      },
      telegramConfig(),
      { sessionKey: "telegram-session", inboundEventKind: "room_event" },
    );

    expect(count).toBe(1);
    end();
  });

  it.each([
    {
      name: "poll",
      params: {
        action: "poll",
        to: "@testchannel",
        question: "Ready?",
        answers: ["Yes", "No"],
      },
      cfg: telegramConfig(),
    },
    {
      name: "sticker",
      params: {
        action: "sendSticker",
        to: "@testchannel",
        fileId: "sticker-1",
      },
      cfg: telegramConfig({ actions: { sticker: true } }),
    },
  ])("marks room-event delivery after successful $name actions", async ({ params, cfg }) => {
    let count = 0;
    const end = beginTelegramInboundEventDeliveryCorrelation(
      "telegram-session",
      {
        outboundTo: "@testchannel",
        markInboundEventDelivered: () => {
          count += 1;
        },
      },
      { inboundEventKind: "room_event" },
    );

    await handleTelegramAction(params, cfg, {
      sessionKey: "telegram-session",
      inboundEventKind: "room_event",
    });

    expect(count).toBe(1);
    end();
  });

  it("accepts shared send action aliases", async () => {
    await handleTelegramAction(
      {
        action: "send",
        to: "@testchannel",
        message: "Hello from alias",
        media: "https://example.com/image.jpg",
      },
      telegramConfig(),
      { gatewayClientScopes: ["operator.write"] },
    );
    const call = mockCall(sendMessageTelegram, 0, "send alias");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Hello from alias");
    const options = requireRecord(call[2], "send alias options");
    expect(options.token).toBe("tok");
    expect(options.mediaUrl).toBe("https://example.com/image.jpg");
  });

  it.each(["path", "filePath"] as const)("uses top-level %s as sendMessage media", async (key) => {
    const mediaPath = `/tmp/customer_support_${key}.png`;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "telegram:-100123:topic:879",
        message: "Productivity",
        [key]: mediaPath,
      },
      telegramConfig(),
    );
    const call = mockCall(sendMessageTelegram, 0, `${key} media`);
    expect(call[0]).toBe("telegram:-100123:topic:879");
    expect(call[1]).toBe("Productivity");
    const options = requireRecord(call[2], `${key} media options`);
    expect(options.token).toBe("tok");
    expect(options.mediaUrl).toBe(mediaPath);
  });

  it("sends all attachment paths as sendMessage media", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "telegram:-100123:topic:879",
        message: "1/2 Productivity",
        attachments: [
          {
            type: "image",
            path: "/tmp/customer_support_productivity.png",
            name: "customer_support_productivity.png",
          },
          {
            type: "image",
            filePath: "/tmp/customer_support_resolution.png",
            name: "customer_support_resolution.png",
          },
        ],
      },
      telegramConfig(),
    );
    const call = mockCall(sendMessageTelegram, 0, "attachment media");
    expect(call[0]).toBe("telegram:-100123:topic:879");
    expect(call[1]).toBe("1/2 Productivity");
    const options = requireRecord(call[2], "attachment media options");
    expect(options.token).toBe("tok");
    expect(options.mediaUrl).toBe("/tmp/customer_support_productivity.png");
    const followUpCall = mockCall(sendMessageTelegram, 1, "second attachment media");
    expect(followUpCall[0]).toBe("telegram:-100123:topic:879");
    expect(followUpCall[1]).toBe("");
    const followUpOptions = requireRecord(followUpCall[2], "second attachment media options");
    expect(followUpOptions.token).toBe("tok");
    expect(followUpOptions.mediaUrl).toBe("/tmp/customer_support_resolution.png");
  });

  it("sends a poll", async () => {
    const result = await handleTelegramAction(
      {
        action: "poll",
        to: "@testchannel",
        question: "Ready?",
        answers: ["Yes", "No"],
        allowMultiselect: true,
        durationSeconds: 60,
        isAnonymous: false,
        silent: true,
      },
      telegramConfig(),
    );
    const call = mockCall(sendPollTelegram, 0, "send poll");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toEqual({
      question: "Ready?",
      options: ["Yes", "No"],
      maxSelections: 2,
      durationSeconds: 60,
      durationHours: undefined,
    });
    const options = requireRecord(call[2], "send poll options");
    expect(options.token).toBe("tok");
    expect(options.isAnonymous).toBe(false);
    expect(options.silent).toBe(true);
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("790");
    expect(details.chatId).toBe("123");
    expect(details.pollId).toBe("poll-1");
  });

  it("rejects fractional poll durations before sending", async () => {
    await expect(
      handleTelegramAction(
        {
          action: "poll",
          to: "@testchannel",
          question: "Ready?",
          answers: ["Yes", "No"],
          durationSeconds: 60.5,
        },
        telegramConfig(),
      ),
    ).rejects.toThrow("durationSeconds must be a positive integer.");
    expect(sendPollTelegram).not.toHaveBeenCalled();
  });

  it("accepts shared poll action aliases", async () => {
    await handleTelegramAction(
      {
        action: "poll",
        to: "@testchannel",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
        pollMulti: "true",
        pollPublic: "true",
        pollDurationSeconds: 60,
        replyTo: 55,
        threadId: 77,
        silent: "true",
      },
      telegramConfig(),
    );
    const call = mockCall(sendPollTelegram, 0, "poll alias");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toEqual({
      question: "Ready?",
      options: ["Yes", "No"],
      maxSelections: 2,
      durationSeconds: 60,
      durationHours: undefined,
    });
    const options = requireRecord(call[2], "poll alias options");
    expect(options.token).toBe("tok");
    expect(options.isAnonymous).toBe(false);
    expect(options.replyToMessageId).toBe(55);
    expect(options.messageThreadId).toBe(77);
    expect(options.silent).toBe(true);
  });

  it("parses string booleans for poll flags", async () => {
    await handleTelegramAction(
      {
        action: "poll",
        to: "@testchannel",
        question: "Ready?",
        answers: ["Yes", "No"],
        allowMultiselect: "true",
        isAnonymous: "false",
        silent: "true",
      },
      telegramConfig(),
    );
    const call = mockCall(sendPollTelegram, 0, "poll string booleans");
    expect(call[0]).toBe("@testchannel");
    const poll = requireRecord(call[1], "poll string booleans payload");
    expect(poll.question).toBe("Ready?");
    expect(poll.options).toEqual(["Yes", "No"]);
    expect(poll.maxSelections).toBe(2);
    const options = requireRecord(call[2], "poll string booleans options");
    expect(options.isAnonymous).toBe(false);
    expect(options.silent).toBe(true);
  });

  it("forwards trusted mediaLocalRoots into sendMessageTelegram", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello with local media",
      },
      telegramConfig(),
      { mediaLocalRoots: ["/tmp/agent-root"] },
    );
    const call = mockCall(sendMessageTelegram, 0, "local media roots");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Hello with local media");
    expect(requireRecord(call[2], "local media roots options").mediaLocalRoots).toEqual([
      "/tmp/agent-root",
    ]);
  });

  it("forwards gateway client scopes into Telegram send target resolution", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello from CLI",
      },
      telegramConfig(),
      { gatewayClientScopes: ["operator.write"] },
    );
    const call = mockCall(sendMessageTelegram, 0, "gateway-scoped send");
    expect(requireRecord(call[2], "gateway-scoped send options").gatewayClientScopes).toEqual([
      "operator.write",
    ]);
  });

  it("forwards gateway client scopes into Telegram poll target resolution", async () => {
    await handleTelegramAction(
      {
        action: "poll",
        to: "@testchannel",
        question: "Ready?",
        answers: ["Yes", "No"],
      },
      telegramConfig(),
      { gatewayClientScopes: ["operator.write"] },
    );
    const call = mockCall(sendPollTelegram, 0, "gateway-scoped poll");
    expect(requireRecord(call[2], "gateway-scoped poll options").gatewayClientScopes).toEqual([
      "operator.write",
    ]);
  });

  it.each([
    {
      name: "react",
      params: { action: "react", chatId: "123", messageId: 456, emoji: "✅" },
      cfg: reactionConfig("minimal"),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(reactMessageTelegram.mock.calls as unknown[][], 3),
    },
    {
      name: "sendMessage",
      params: { action: "sendMessage", to: "123", content: "hello" },
      cfg: telegramConfig(),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(sendMessageTelegram.mock.calls as unknown[][], 2),
    },
    {
      name: "poll",
      params: {
        action: "poll",
        to: "123",
        question: "Q?",
        answers: ["A", "B"],
      },
      cfg: telegramConfig(),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(sendPollTelegram.mock.calls as unknown[][], 2),
    },
    {
      name: "deleteMessage",
      params: { action: "deleteMessage", chatId: "123", messageId: 1 },
      cfg: telegramConfig(),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(deleteMessageTelegram.mock.calls as unknown[][], 2),
    },
    {
      name: "editMessage",
      params: { action: "editMessage", chatId: "123", messageId: 1, content: "updated" },
      cfg: telegramConfig(),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(editMessageTelegram.mock.calls as unknown[][], 3),
    },
    {
      name: "sendSticker",
      params: { action: "sendSticker", to: "123", fileId: "sticker-1" },
      cfg: telegramConfig({ actions: { sticker: true } }),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(sendStickerTelegram.mock.calls as unknown[][], 2),
    },
    {
      name: "createForumTopic",
      params: { action: "createForumTopic", chatId: "123", name: "Topic" },
      cfg: telegramConfig({ actions: { createForumTopic: true } }),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(createForumTopicTelegram.mock.calls as unknown[][], 2),
    },
    {
      name: "editForumTopic",
      params: { action: "editForumTopic", chatId: "123", messageThreadId: 42, name: "New" },
      cfg: telegramConfig({ actions: { editForumTopic: true } }),
      assertCall: (
        readCallOpts: (calls: unknown[][], argIndex: number) => Record<string, unknown>,
      ) => readCallOpts(editForumTopicTelegram.mock.calls as unknown[][], 2),
    },
  ])(
    "forwards resolved cfg and gateway scopes for $name action",
    async ({ params, cfg, assertCall }) => {
      const readCallOpts = (calls: unknown[][], argIndex: number): Record<string, unknown> => {
        const args = calls[0];
        if (!Array.isArray(args)) {
          throw new Error("Expected Telegram action call args");
        }
        const opts = args[argIndex];
        if (!opts || typeof opts !== "object") {
          throw new Error("Expected Telegram action options object");
        }
        return opts as Record<string, unknown>;
      };
      await handleTelegramAction(params as Record<string, unknown>, cfg, {
        gatewayClientScopes: ["operator.write"],
      });
      const opts = assertCall(readCallOpts);
      expect(opts.cfg).toBe(cfg);
      expect(opts.gatewayClientScopes).toEqual(["operator.write"]);
    },
  );

  it("stores created forum topic names in the account-scoped cache", async () => {
    createForumTopicTelegram.mockResolvedValueOnce({
      topicId: 99,
      name: "Topic",
      chatId: "-100123",
    });
    const cfg = {
      ...telegramConfig({ actions: { createForumTopic: true } }),
      session: { store: path.join(os.tmpdir(), "openclaw-telegram-action-sessions.json") },
    } as OpenClawConfig;

    await handleTelegramAction(
      { action: "createForumTopic", accountId: "work", chatId: "alias-chat", name: "Topic" },
      cfg,
    );

    const scope = topicCacheScopeFor(cfg, "work");
    await expect(getTopicName("-100123", 99, scope)).resolves.toBe("Topic");
    await expect(getTopicName("alias-chat", 99, scope)).resolves.toBeUndefined();
  });

  it("stores edited forum topic names in the account-scoped cache", async () => {
    editForumTopicTelegram.mockResolvedValueOnce({
      ok: true,
      chatId: "-100123",
      messageThreadId: 42,
      name: "New",
    });
    const cfg = {
      ...telegramConfig({ actions: { editForumTopic: true } }),
      session: { store: path.join(os.tmpdir(), "openclaw-telegram-action-sessions.json") },
    } as OpenClawConfig;

    await handleTelegramAction(
      {
        action: "editForumTopic",
        accountId: "work",
        chatId: "alias-chat",
        messageThreadId: 42,
        name: "New",
      },
      cfg,
    );

    await expect(getTopicName("-100123", 42, topicCacheScopeFor(cfg, "work"))).resolves.toBe("New");
  });

  it.each([
    {
      name: "media",
      params: {
        action: "sendMessage",
        to: "123456",
        content: "Check this image!",
        mediaUrl: "https://example.com/image.jpg",
      },
      expectedTo: "123456",
      expectedContent: "Check this image!",
      expectedOptions: { mediaUrl: "https://example.com/image.jpg" },
    },
    {
      name: "quoteText",
      params: {
        action: "sendMessage",
        to: "123456",
        content: "Replying now",
        replyToMessageId: 144,
        quoteText: "The text you want to quote",
      },
      expectedTo: "123456",
      expectedContent: "Replying now",
      expectedOptions: {
        replyToMessageId: 144,
        quoteText: "The text you want to quote",
      },
    },
    {
      name: "media-only",
      params: {
        action: "sendMessage",
        to: "123456",
        mediaUrl: "https://example.com/note.ogg",
      },
      expectedTo: "123456",
      expectedContent: "",
      expectedOptions: { mediaUrl: "https://example.com/note.ogg" },
    },
  ] as const)("maps sendMessage params for $name", async (testCase) => {
    await handleTelegramAction(testCase.params, telegramConfig());
    const call = mockCall(sendMessageTelegram, 0, `sendMessage params ${testCase.name}`);
    expect(call[0]).toBe(testCase.expectedTo);
    expect(call[1]).toBe(testCase.expectedContent);
    const options = requireRecord(call[2], `sendMessage params ${testCase.name} options`);
    expect(options.token).toBe("tok");
    for (const [key, value] of Object.entries(testCase.expectedOptions)) {
      expect(options[key]).toEqual(value);
    }
  });

  it("requires content when no mediaUrl is provided", async () => {
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "123456",
        },
        telegramConfig(),
      ),
    ).rejects.toThrow(/content required/i);
  });

  it("renders presentation text when message content is omitted", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        presentation: {
          title: "Status",
          blocks: [
            { type: "text", text: "Build completed" },
            { type: "context", text: "main branch" },
          ],
        },
      },
      telegramConfig(),
    );

    const call = mockCall(sendMessageTelegram, 0, "presentation text");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe("Status\n\nBuild completed\n\nmain branch");
    expect(requireRecord(call[2], "presentation text options").token).toBe("tok");
  });

  it("appends chart data when explicit message content is present", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        message: "Quarterly results",
        presentation: {
          title: "FY25 outlook",
          blocks: [
            { type: "text", text: "Do not duplicate this block" },
            {
              type: "chart",
              chartType: "bar",
              title: "Revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "USD", values: [12, 18] }],
            },
          ],
        },
      },
      telegramConfig(),
    );

    const call = mockCall(sendMessageTelegram, 0, "mixed message and chart");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe(
      "Quarterly results\n\nFY25 outlook\n\nRevenue (bar chart)\n- USD: Q1: 12; Q2: 18",
    );
    expect(requireRecord(call[2], "mixed message and chart options").token).toBe("tok");
  });

  it("uses presentation fallback text for button-only sends", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
      telegramConfig({ capabilities: { inlineButtons: "all" } }),
    );

    const call = mockCall(sendMessageTelegram, 0, "button-only fallback");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe("- Approve");
    expect(requireRecord(call[2], "button-only fallback options").buttons).toEqual([
      [{ text: "Approve", callback_data: "approve" }],
    ]);
  });

  it("edits reply markup when editMessage only changes buttons", async () => {
    await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open", url: "https://example.com" }],
            },
          ],
        },
      },
      telegramConfig({ capabilities: { inlineButtons: "all" } }),
    );

    expect(editMessageTelegram).not.toHaveBeenCalled();
    const call = mockCall(editMessageReplyMarkupTelegram, 0, "reply markup edit");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe(321);
    expect(call[2]).toEqual([[{ text: "Open", url: "https://example.com" }]]);
    expect(requireRecord(call[3], "reply markup edit options").token).toBe("tok");
  });

  it("uses Telegram caption edits when editMessage receives a caption", async () => {
    await handleTelegramAction(
      {
        action: "editMessage",
        chatId: "123456",
        messageId: 321,
        caption: "Updated caption",
      },
      telegramConfig(),
    );

    const call = mockCall(editMessageTelegram, 0, "caption edit");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe(321);
    expect(call[2]).toBe("Updated caption");
    expect(requireRecord(call[3], "caption edit options").editMode).toBe("caption");
  });

  it("pins action sends when delivery pin is requested", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        content: "Pin this",
        delivery: { pin: { enabled: true } },
      },
      telegramConfig(),
      { gatewayClientScopes: ["operator.write"] },
    );

    const call = mockCall(pinMessageTelegram, 0, "delivery pin");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe("789");
    const options = requireRecord(call[2], "delivery pin options");
    expect(options.accountId).toBeUndefined();
    expect(options.verbose).toBe(false);
    expect(options.gatewayClientScopes).toEqual(["operator.write"]);
    const durableCall = mockCall(sendDurableMessageBatch, 0, "durable delivery pin");
    expect(requireRecord(durableCall[0], "durable delivery pin params")).toMatchObject({
      payloads: [{ delivery: { pin: { enabled: true } } }],
    });
  });

  it("passes delivery pin notify requests for action sends", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        content: "Pin this loudly",
        delivery: { pin: { enabled: true, notify: true } },
      },
      telegramConfig(),
    );

    const call = mockCall(pinMessageTelegram, 0, "delivery pin notify");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe("789");
    expect(requireRecord(call[2], "delivery pin notify options").notify).toBe(true);
    const durableCall = mockCall(sendDurableMessageBatch, 0, "durable delivery pin notify");
    expect(requireRecord(durableCall[0], "durable delivery pin notify params")).toMatchObject({
      payloads: [{ delivery: { pin: { enabled: true, notify: true } } }],
    });
  });

  it("fails required action-send pins when pinning fails", async () => {
    pinMessageTelegram.mockRejectedValueOnce(new Error("pin failed"));

    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "123456",
          content: "Pin this",
          delivery: { pin: { enabled: true, required: true } },
        },
        telegramConfig(),
      ),
    ).rejects.toThrow(/pin failed/);
  });

  it("respects sendMessage gating", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", actions: { sendMessage: false } },
      },
    } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "@testchannel",
          content: "Hello!",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram sendMessage is disabled/);
  });

  it("respects poll gating", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", actions: { poll: false } },
      },
    } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "poll",
          to: "@testchannel",
          question: "Lunch?",
          answers: ["Pizza", "Sushi"],
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram polls are disabled/);
  });

  it("deletes a message", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "deleteMessage",
        chatId: "123",
        messageId: 456,
      },
      cfg,
    );
    const call = mockCall(deleteMessageTelegram, 0, "delete message");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe(456);
    expect(requireRecord(call[2], "delete message options").token).toBe("tok");
  });

  it("rejects fractional message ids before mutating messages", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;

    await expect(
      handleTelegramAction(
        {
          action: "deleteMessage",
          chatId: "123",
          messageId: 456.5,
        },
        cfg,
      ),
    ).rejects.toThrow("messageId must be a positive integer.");
    await expect(
      handleTelegramAction(
        {
          action: "editMessage",
          chatId: "123",
          messageId: 456.5,
          content: "updated",
        },
        cfg,
      ),
    ).rejects.toThrow("messageId must be a positive integer.");
    expect(deleteMessageTelegram).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("surfaces non-fatal delete warnings", async () => {
    deleteMessageTelegram.mockResolvedValueOnce({
      ok: false,
      warning: "Message 456 was not deleted: 400: Bad Request: message can't be deleted",
    } as unknown as Awaited<ReturnType<typeof deleteMessageTelegram>>);
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;

    const result = await handleTelegramAction(
      {
        action: "deleteMessage",
        chatId: "123",
        messageId: 456,
      },
      cfg,
    );

    const textPayload = result.content.find((item) => item.type === "text");
    expect(textPayload?.type).toBe("text");
    const parsed = JSON.parse((textPayload as { type: "text"; text: string }).text) as {
      ok: boolean;
      deleted?: boolean;
      warning?: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.deleted).toBe(false);
    expect(parsed.warning).toBe(
      "Message 456 was not deleted: 400: Bad Request: message can't be deleted",
    );
  });

  it("respects deleteMessage gating", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", actions: { deleteMessage: false } },
      },
    } as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "deleteMessage",
          chatId: "123",
          messageId: 456,
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram deleteMessage is disabled/);
  });

  it("throws on missing bot token for sendMessage", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const cfg = {} as OpenClawConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "@testchannel",
          content: "Hello!",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram bot token missing/);
  });

  it("allows inline buttons by default (allowlist)", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as OpenClawConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Choose",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Ok", value: "cmd:ok" }] }],
        },
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("allows inline buttons when legacy capabilities are empty", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Choose",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Ok", value: "cmd:ok" }] }],
        },
      },
      telegramConfig({ capabilities: [] }),
    );
    const call = mockCall(sendMessageTelegram, 0, "empty legacy capabilities");
    expect(call[0]).toBe("@testchannel");
    expect(requireRecord(call[2], "empty legacy capabilities options").buttons).toEqual([
      [{ text: "Ok", callback_data: "cmd:ok" }],
    ]);
  });

  it("uses interactive button labels as fallback text when message text is omitted", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "cmd:retry" }] }],
        },
      },
      telegramConfig({ capabilities: { inlineButtons: "all" } }),
    );
    const call = mockCall(sendMessageTelegram, 0, "interactive button fallback");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("- Retry");
    expect(requireRecord(call[2], "interactive button fallback options").buttons).toEqual([
      [{ text: "Retry", callback_data: "cmd:retry" }],
    ]);
  });

  it.each([
    {
      name: "scope is off",
      to: "@testchannel",
      inlineButtons: "off" as const,
      expectedMessage: /inline buttons are disabled/i,
    },
    {
      name: "scope is dm and target is group",
      to: "-100123456",
      inlineButtons: "dm" as const,
      expectedMessage: /inline buttons are limited to DMs/i,
    },
  ])("blocks inline buttons when $name", async ({ to, inlineButtons, expectedMessage }) => {
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to,
          content: "Choose",
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Ok", value: "cmd:ok" }] }],
          },
        },
        telegramConfig({ capabilities: { inlineButtons } }),
      ),
    ).rejects.toThrow(expectedMessage);
  });

  it("allows inline buttons in DMs with tg: prefixed targets", async () => {
    await sendInlineButtonsMessage({
      to: "tg:5232990709",
      buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
      inlineButtons: "dm",
    });
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("allows inline buttons in groups with topic targets", async () => {
    await sendInlineButtonsMessage({
      to: "telegram:group:-1001234567890:topic:456",
      buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
      inlineButtons: "group",
    });
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("sends messages with inline keyboard buttons when enabled", async () => {
    await sendInlineButtonsMessage({
      to: "@testchannel",
      buttons: [[{ text: "  Option A ", callback_data: " cmd:a " }]],
      inlineButtons: "all",
    });
    const call = mockCall(sendMessageTelegram, 0, "inline keyboard");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Choose");
    expect(requireRecord(call[2], "inline keyboard options").buttons).toEqual([
      [{ text: "Option A", callback_data: "cmd:a" }],
    ]);
  });

  it("forwards optional button style", async () => {
    await sendInlineButtonsMessage({
      to: "@testchannel",
      inlineButtons: "all",
      buttons: [
        [
          {
            text: "Option A",
            callback_data: "cmd:a",
            style: "primary",
          },
        ],
      ],
    });
    const call = mockCall(sendMessageTelegram, 0, "inline keyboard style");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Choose");
    expect(requireRecord(call[2], "inline keyboard style options").buttons).toEqual([
      [
        {
          text: "Option A",
          callback_data: "cmd:a",
          style: "primary",
        },
      ],
    ]);
  });

  it("forwards web app buttons from generic presentation", async () => {
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "5232990709",
        content: "Choose",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Launch",
                  web_app: { url: "https://example.com/app" },
                  style: "primary",
                },
              ],
            },
          ],
        },
      },
      telegramConfig({ capabilities: { inlineButtons: "dm" } }),
    );
    const call = mockCall(sendMessageTelegram, 0, "inline keyboard web app");
    expect(call[0]).toBe("5232990709");
    expect(call[1]).toBe("Choose");
    expect(requireRecord(call[2], "inline keyboard web app options").buttons).toEqual([
      [
        {
          text: "Launch",
          web_app: { url: "https://example.com/app" },
          style: "primary",
        },
      ],
    ]);
  });
});

describe("handleTelegramAction per-account gating", () => {
  function accountTelegramConfig(params: {
    accounts: Record<
      string,
      { botToken: string; actions?: { sticker?: boolean; reactions?: boolean } }
    >;
    topLevelBotToken?: string;
    topLevelActions?: { reactions?: boolean };
  }): OpenClawConfig {
    return {
      channels: {
        telegram: {
          ...(params.topLevelBotToken ? { botToken: params.topLevelBotToken } : {}),
          ...(params.topLevelActions ? { actions: params.topLevelActions } : {}),
          accounts: params.accounts,
        },
      },
    } as OpenClawConfig;
  }

  async function expectAccountStickerSend(cfg: OpenClawConfig, accountId = "media") {
    await handleTelegramAction(
      { action: "sendSticker", to: "123", fileId: "sticker-id", accountId },
      cfg,
    );
    const call = mockCall(sendStickerTelegram, 0, "account sticker");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe("sticker-id");
    expect(requireRecord(call[2], "account sticker options").token).toBe("tok-media");
  }

  it("allows sticker when account config enables it", async () => {
    const cfg = accountTelegramConfig({
      accounts: {
        media: { botToken: "tok-media", actions: { sticker: true } },
      },
    });
    await expectAccountStickerSend(cfg);
  });

  it("blocks sticker when account omits it", async () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            chat: { botToken: "tok-chat" },
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      handleTelegramAction(
        { action: "sendSticker", to: "123", fileId: "sticker-id", accountId: "chat" },
        cfg,
      ),
    ).rejects.toThrow(/sticker actions are disabled/i);
  });

  it("uses account-merged config, not top-level config", async () => {
    // Top-level has no sticker enabled, but the account does
    const cfg = accountTelegramConfig({
      topLevelBotToken: "tok-base",
      accounts: {
        media: { botToken: "tok-media", actions: { sticker: true } },
      },
    });
    await expectAccountStickerSend(cfg);
  });

  it("inherits top-level reaction gate when account overrides sticker only", async () => {
    const cfg = accountTelegramConfig({
      topLevelActions: { reactions: false },
      accounts: {
        media: { botToken: "tok-media", actions: { sticker: true } },
      },
    });

    const result = await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: 1,
        emoji: "👀",
        accountId: "media",
      },
      cfg,
    );
    const details = resultDetails(result);
    expect(details.ok).toBe(false);
    expect(details.reason).toBe("disabled");
  });

  it("allows account to explicitly re-enable top-level disabled reaction gate", async () => {
    const cfg = accountTelegramConfig({
      topLevelActions: { reactions: false },
      accounts: {
        media: { botToken: "tok-media", actions: { sticker: true, reactions: true } },
      },
    });

    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: 1,
        emoji: "👀",
        accountId: "media",
      },
      cfg,
    );

    const call = mockCall(reactMessageTelegram, 0, "account reaction");
    expect(call[0]).toBe("123");
    expect(call[1]).toBe(1);
    expect(call[2]).toBe("👀");
    const options = requireRecord(call[3], "account reaction options");
    expect(options.token).toBe("tok-media");
    expect(options.accountId).toBe("media");
  });
});
