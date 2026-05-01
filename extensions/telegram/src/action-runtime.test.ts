import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramAction, telegramActionRuntime } from "./action-runtime.js";

const originalTelegramActionRuntime = { ...telegramActionRuntime };
const reactMessageTelegram = vi.fn(async () => ({ ok: true }));
const sendMessageTelegram = vi.fn(async () => ({
  messageId: "789",
  chatId: "123",
}));
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
const editForumTopicTelegram = vi.fn(async () => ({
  ok: true,
  chatId: "123",
  messageThreadId: 42,
  name: "Renamed",
}));
const pinMessageTelegram = vi.fn(async () => ({
  ok: true,
  messageId: "789",
  chatId: "123",
}));
const createForumTopicTelegram = vi.fn(async () => ({
  topicId: 99,
  name: "Topic",
  chatId: "123",
}));
let envSnapshot: ReturnType<typeof captureEnv>;

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
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ token: "tok", remove: false }),
    );
  }

  beforeEach(() => {
    envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN"]);
    Object.assign(telegramActionRuntime, originalTelegramActionRuntime, {
      reactMessageTelegram,
      sendMessageTelegram,
      sendPollTelegram,
      sendStickerTelegram,
      deleteMessageTelegram,
      editMessageTelegram,
      editForumTopicTelegram,
      pinMessageTelegram,
      createForumTopicTelegram,
    });
    reactMessageTelegram.mockClear();
    sendMessageTelegram.mockClear();
    sendPollTelegram.mockClear();
    sendStickerTelegram.mockClear();
    deleteMessageTelegram.mockClear();
    editMessageTelegram.mockClear();
    editForumTopicTelegram.mockClear();
    pinMessageTelegram.mockClear();
    createForumTopicTelegram.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = "tok";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("adds reactions when reactionLevel is minimal", async () => {
    await expectReactionAdded("minimal");
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
    expect(parsed).toMatchObject({
      ok: false,
      warning: "Reaction unavailable: ✅",
      added: "✅",
    });
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
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ token: "tok", remove: false }),
    );
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
    expect(result.details).toMatchObject({
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
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "",
      expect.objectContaining({ token: "tok", remove: false }),
    );
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
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker",
      expect.objectContaining({ token: "tok" }),
    );
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
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker",
      expect.objectContaining({
        token: "tok",
        replyToMessageId: 9,
        messageThreadId: 11,
      }),
    );
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
    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      456,
      "✅",
      expect.objectContaining({ token: "tok", remove: true }),
    );
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
      expect(result.details).toMatchObject({
        ok: false,
        reason: "disabled",
      });
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
    expect(result.details).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("sends a text message", async () => {
    const result = await handleTelegramAction(
      {
        action: "sendMessage",
        to: "@testchannel",
        content: "Hello, Telegram!",
      },
      telegramConfig(),
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

  it("accepts shared send action aliases", async () => {
    await handleTelegramAction(
      {
        action: "send",
        to: "@testchannel",
        message: "Hello from alias",
        media: "https://example.com/image.jpg",
      },
      telegramConfig(),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Hello from alias",
      expect.objectContaining({
        token: "tok",
        mediaUrl: "https://example.com/image.jpg",
      }),
    );
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
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "@testchannel",
      {
        question: "Ready?",
        options: ["Yes", "No"],
        maxSelections: 2,
        durationSeconds: 60,
        durationHours: undefined,
      },
      expect.objectContaining({
        token: "tok",
        isAnonymous: false,
        silent: true,
      }),
    );
    expect(result.details).toMatchObject({
      ok: true,
      messageId: "790",
      chatId: "123",
      pollId: "poll-1",
    });
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
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "@testchannel",
      {
        question: "Ready?",
        options: ["Yes", "No"],
        maxSelections: 2,
        durationSeconds: 60,
        durationHours: undefined,
      },
      expect.objectContaining({
        token: "tok",
        isAnonymous: false,
        replyToMessageId: 55,
        messageThreadId: 77,
        silent: true,
      }),
    );
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
    expect(sendPollTelegram).toHaveBeenCalledWith(
      "@testchannel",
      expect.objectContaining({
        question: "Ready?",
        options: ["Yes", "No"],
        maxSelections: 2,
      }),
      expect.objectContaining({
        isAnonymous: false,
        silent: true,
      }),
    );
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
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Hello with local media",
      expect.objectContaining({ mediaLocalRoots: ["/tmp/agent-root"] }),
    );
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
  ])("forwards resolved cfg for $name action", async ({ params, cfg, assertCall }) => {
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
    await handleTelegramAction(params as Record<string, unknown>, cfg);
    const opts = assertCall(readCallOpts);
    expect(opts.cfg).toBe(cfg);
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
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      testCase.expectedTo,
      testCase.expectedContent,
      expect.objectContaining({
        token: "tok",
        ...testCase.expectedOptions,
      }),
    );
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

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "Status\n\nBuild completed\n\nmain branch",
      expect.objectContaining({ token: "tok" }),
    );
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

    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "- Approve",
      expect.objectContaining({
        buttons: [[{ text: "Approve", callback_data: "approve" }]],
      }),
    );
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
    );

    expect(pinMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "789",
      expect.objectContaining({ accountId: undefined, verbose: false }),
    );
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

    expect(pinMessageTelegram).toHaveBeenCalledWith(
      "123456",
      "789",
      expect.objectContaining({ notify: true }),
    );
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
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "- Retry",
      expect.objectContaining({
        buttons: [[{ text: "Retry", callback_data: "cmd:retry" }]],
      }),
    );
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
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Choose",
      expect.objectContaining({
        buttons: [[{ text: "Option A", callback_data: "cmd:a" }]],
      }),
    );
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
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "@testchannel",
      "Choose",
      expect.objectContaining({
        buttons: [
          [
            {
              text: "Option A",
              callback_data: "cmd:a",
              style: "primary",
            },
          ],
        ],
      }),
    );
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
    expect(sendStickerTelegram).toHaveBeenCalledWith(
      "123",
      "sticker-id",
      expect.objectContaining({ token: "tok-media" }),
    );
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
    expect(result.details).toMatchObject({
      ok: false,
      reason: "disabled",
    });
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

    expect(reactMessageTelegram).toHaveBeenCalledWith(
      "123",
      1,
      "👀",
      expect.objectContaining({ token: "tok-media", accountId: "media" }),
    );
  });
});
