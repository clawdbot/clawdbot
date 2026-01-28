import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import { handleTelegramAction, readTelegramButtons } from "./telegram-actions.js";

const reactMessageTelegram = vi.fn(async () => ({ ok: true }));
const sendMessageTelegram = vi.fn(async () => ({
  messageId: "789",
  chatId: "123",
}));
const sendStickerTelegram = vi.fn(async () => ({
  messageId: "456",
  chatId: "123",
}));
const deleteMessageTelegram = vi.fn(async () => ({ ok: true }));
const originalToken = process.env.TELEGRAM_BOT_TOKEN;

vi.mock("../../telegram/send.js", () => ({
  reactMessageTelegram: (...args: unknown[]) => reactMessageTelegram(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegram(...args),
  sendStickerTelegram: (...args: unknown[]) => sendStickerTelegram(...args),
  deleteMessageTelegram: (...args: unknown[]) => deleteMessageTelegram(...args),
}));

describe("handleTelegramAction", () => {
  beforeEach(() => {
    reactMessageTelegram.mockClear();
    sendMessageTelegram.mockClear();
    sendStickerTelegram.mockClear();
    deleteMessageTelegram.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = "tok";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it("adds reactions when reactionLevel is minimal", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "minimal" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "✅",
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ token: "tok", remove: false }),
    );
  });

  it("adds reactions when reactionLevel is extensive", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "extensive" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "✅",
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ token: "tok", remove: false }),
    );
  });

  it("removes reactions on empty emoji", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "minimal" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "react",
        chatId: "123",
        messageId: "456",
        emoji: "",
      },
      cfg,
    );
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "",
      expect.objectContaining({ token: "tok", remove: false }),
    );
  });

  it("rejects sticker actions when disabled by default", async () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;
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
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendSticker",
        to: "123",
        fileId: "sticker",
      },
      cfg,
    );
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker",
      expect.objectContaining({ token: "tok" }),
    );
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "extensive" } },
    } as MoltbotConfig;
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
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ token: "tok", remove: true }),
    );
  });

  it("blocks reactions when reactionLevel is off", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "off" } },
    } as MoltbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "react",
          chatId: "123",
          messageId: "456",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram agent reactions disabled.*reactionLevel="off"/);
  });

  it("blocks reactions when reactionLevel is ack", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", reactionLevel: "ack" } },
    } as MoltbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "react",
          chatId: "123",
          messageId: "456",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram agent reactions disabled.*reactionLevel="ack"/);
  });

  it("also respects legacy actions.reactions gating", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          reactionLevel: "minimal",
          actions: { reactions: false },
        },
      },
    } as MoltbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "react",
          chatId: "123",
          messageId: "456",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/Telegram reactions are disabled via actions.reactions/);
  });

  it("sends a text message", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as MoltbotConfig;
    const result = await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello, Telegram!",
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Hello, Telegram!",
      expect.objectContaining({ token: "tok", mediaUrl: undefined }),
    );
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining('"ok": true'),
    });
  });

  it("sends a message with media", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        content: "Check this image!",
        mediaUrl: "https://example.com/image.jpg",
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "Check this image!",
      expect.objectContaining({
        token: "tok",
        mediaUrl: "https://example.com/image.jpg",
      }),
    );
  });

  it("passes quoteText when provided", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        content: "Replying now",
        replyToMessageId: 144,
        quoteText: "The text you want to quote",
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "Replying now",
      expect.objectContaining({
        token: "tok",
        replyToMessageId: 144,
        quoteText: "The text you want to quote",
      }),
    );
  });

  it("allows media-only messages without content", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "123456",
        mediaUrl: "https://example.com/note.ogg",
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "",
      expect.objectContaining({
        token: "tok",
        mediaUrl: "https://example.com/note.ogg",
      }),
    );
  });

  it("requires content when no mediaUrl is provided", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as MoltbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "123456",
        },
        cfg,
      ),
    ).rejects.toThrow(/content required/i);
  });

  it("respects sendMessage gating", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", actions: { sendMessage: false } },
      },
    } as MoltbotConfig;
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

  it("deletes a message", async () => {
    const cfg = {
      channels: { telegram: { botToken: "tok" } },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "deleteMessage",
        chatId: "123",
        messageId: 456,
      },
      cfg,
    );
    expect(deleteMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      expect.objectContaining({ token: "tok" }),
    );
  });

  it("respects deleteMessage gating", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", actions: { deleteMessage: false } },
      },
    } as MoltbotConfig;
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
    const cfg = {} as MoltbotConfig;
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
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Choose",
        buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("blocks inline buttons when scope is off", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", capabilities: { inlineButtons: "off" } },
      },
    } as MoltbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "@testchannel",
          content: "Choose",
          buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
        },
        cfg,
      ),
    ).rejects.toThrow(/inline buttons are disabled/i);
  });

  it("blocks inline buttons in groups when scope is dm", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", capabilities: { inlineButtons: "dm" } },
      },
    } as MoltbotConfig;
    await expect(
      handleTelegramAction(
        {
          action: "sendMessage",
          to: "-100123456",
          content: "Choose",
          buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
        },
        cfg,
      ),
    ).rejects.toThrow(/inline buttons are limited to DMs/i);
  });

  it("allows inline buttons in DMs with tg: prefixed targets", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", capabilities: { inlineButtons: "dm" } },
      },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "tg:5232990709",
        content: "Choose",
        buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("allows inline buttons in groups with topic targets", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", capabilities: { inlineButtons: "group" } },
      },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "telegram:group:-1001234567890:topic:456",
        content: "Choose",
        buttons: [[{ text: "Ok", callback_data: "cmd:ok" }]],
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalled();
  });

  it("sends messages with inline keyboard buttons when enabled", async () => {
    const cfg = {
      channels: {
        telegram: { botToken: "tok", capabilities: { inlineButtons: "all" } },
      },
    } as MoltbotConfig;
    await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Choose",
        buttons: [[{ text: "  Option A ", callback_data: " cmd:a " }]],
      },
      cfg,
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Choose",
      expect.objectContaining({
        buttons: [[{ text: "Option A", callback_data: "cmd:a" }]],
      }),
    );
  });
});

describe("readTelegramButtons", () => {
  it("returns trimmed button rows for valid input", () => {
    const result = readTelegramButtons({
      buttons: [[{ text: "  Option A ", callback_data: " cmd:a " }]],
    });
    expect(result).toEqual([[{ text: "Option A", callback_data: "cmd:a" }]]);
  });
});
