import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelegramAction, telegramActionRuntime } from "./action-runtime.js";
import { beginTelegramInboundTurnDeliveryCorrelation } from "./inbound-turn-delivery.js";

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
    );
    const call = mockCall(sendMessageTelegram, 0, "text message");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Hello, Telegram!");
    const options = requireRecord(call[2], "text message options");
    expect(options.token).toBe("tok");
    expect(options.mediaUrl).toBeUndefined();
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

  it("marks the matching inbound turn delivered after a successful send", async () => {
    let count = 0;
    const end = beginTelegramInboundTurnDeliveryCorrelation("telegram-session", {
      outboundTo: "@testchannel",
      markInboundTurnDelivered: () => {
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
    const call = mockCall(sendMessageTelegram, 0, "send alias");
    expect(call[0]).toBe("@testchannel");
    expect(call[1]).toBe("Hello from alias");
    const options = requireRecord(call[2], "send alias options");
    expect(options.token).toBe("tok");
    expect(options.mediaUrl).toBe("https://example.com/image.jpg");
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

    const call = mockCall(pinMessageTelegram, 0, "delivery pin");
    expect(call[0]).toBe("123456");
    expect(call[1]).toBe("789");
    const options = requireRecord(call[2], "delivery pin options");
    expect(options.accountId).toBeUndefined();
    expect(options.verbose).toBe(false);
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
