import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../../config/config.js";
import { telegramMessageActions } from "./telegram.js";

const handleTelegramAction = vi.fn(async () => ({ ok: true }));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramAction(...args),
}));

describe("telegramMessageActions", () => {
  it("excludes sticker actions when not enabled", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).not.toContain("sticker");
    expect(actions).not.toContain("sticker-search");
  });

  it("allows media-only sends and passes asVoice", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "send",
      params: {
        to: "123",
        media: "https://example.com/voice.ogg",
        asVoice: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "123",
        content: "",
        mediaUrl: "https://example.com/voice.ogg",
        asVoice: true,
      }),
      cfg,
    );
  });

  it("passes silent flag for silent sends", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "send",
      params: {
        to: "456",
        message: "Silent notification test",
        silent: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "456",
        content: "Silent notification test",
        silent: true,
      }),
      cfg,
    );
  });

  it("maps edit action params into editMessage", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "edit",
      params: {
        chatId: "123",
        messageId: 42,
        message: "Updated",
        buttons: [],
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "editMessage",
        chatId: "123",
        messageId: 42,
        content: "Updated",
        buttons: [],
        accountId: undefined,
      },
      cfg,
    );
  });

  it("rejects non-integer messageId for edit before reaching telegram-actions", async () => {
    handleTelegramAction.mockClear();
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;

    await expect(
      telegramMessageActions.handleAction({
        action: "edit",
        params: {
          chatId: "123",
          messageId: "nope",
          message: "Updated",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow();

    expect(handleTelegramAction).not.toHaveBeenCalled();
  });

  it("excludes forum topic actions when not enabled", () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as MoltbotConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).not.toContain("topic-create");
    expect(actions).not.toContain("topic-edit");
    expect(actions).not.toContain("topic-close");
    expect(actions).not.toContain("topic-reopen");
    expect(actions).not.toContain("topic-delete");
  });

  it("includes forum topic actions when forumTopics is enabled", () => {
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;
    const actions = telegramMessageActions.listActions({ cfg });
    expect(actions).toContain("topic-create");
    expect(actions).toContain("topic-edit");
    expect(actions).toContain("topic-close");
    expect(actions).toContain("topic-reopen");
    expect(actions).toContain("topic-delete");
  });

  it("maps topic-create action to createForumTopic", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "topic-create",
      params: {
        to: "-1001234567890",
        name: "My New Topic",
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: "emoji123",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "createForumTopic",
        chatId: "-1001234567890",
        name: "My New Topic",
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: "emoji123",
        accountId: undefined,
      },
      cfg,
    );
  });

  it("maps topic-edit action to editForumTopic", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "topic-edit",
      params: {
        to: "-1001234567890",
        messageThreadId: 42,
        name: "Renamed Topic",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "editForumTopic",
        chatId: "-1001234567890",
        messageThreadId: 42,
        name: "Renamed Topic",
        iconCustomEmojiId: undefined,
        accountId: undefined,
      },
      cfg,
    );
  });

  it("maps topic-close action to closeForumTopic", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "topic-close",
      params: {
        to: "-1001234567890",
        messageThreadId: 42,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "closeForumTopic",
        chatId: "-1001234567890",
        messageThreadId: 42,
        accountId: undefined,
      },
      cfg,
    );
  });

  it("maps topic-reopen action to reopenForumTopic", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "topic-reopen",
      params: {
        to: "-1001234567890",
        messageThreadId: 42,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "reopenForumTopic",
        chatId: "-1001234567890",
        messageThreadId: 42,
        accountId: undefined,
      },
      cfg,
    );
  });

  it("maps topic-delete action to deleteForumTopic", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await telegramMessageActions.handleAction({
      action: "topic-delete",
      params: {
        to: "-1001234567890",
        messageThreadId: 42,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "deleteForumTopic",
        chatId: "-1001234567890",
        messageThreadId: 42,
        accountId: undefined,
      },
      cfg,
    );
  });

  it("requires messageThreadId for topic-edit", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await expect(
      telegramMessageActions.handleAction({
        action: "topic-edit",
        params: {
          to: "-1001234567890",
          name: "Renamed",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow();

    expect(handleTelegramAction).not.toHaveBeenCalled();
  });

  it("requires name for topic-create", async () => {
    handleTelegramAction.mockClear();
    const cfg = {
      channels: { telegram: { botToken: "tok", actions: { forumTopics: true } } },
    } as MoltbotConfig;

    await expect(
      telegramMessageActions.handleAction({
        action: "topic-create",
        params: {
          to: "-1001234567890",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow();

    expect(handleTelegramAction).not.toHaveBeenCalled();
  });
});
