// Telegram tests cover delivery plugin behavior.
import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramPromptContextProjectionSequence } from "../prompt-context-projection.js";
const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));
const { probeVideoDimensions } = vi.hoisted(() => ({
  probeVideoDimensions: vi.fn(),
}));
const triggerInternalHook = vi.hoisted(() => vi.fn(async () => {}));
const messageHookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSending: vi.fn(),
  runMessageSent: vi.fn(),
}));
const baseDeliveryParams = {
  chatId: "123",
  token: "tok",
  replyToMode: "off",
  textLimit: 4000,
} as const;
type DeliverRepliesParams = Parameters<typeof deliverReplies>[0];
type DeliverWithParams = Omit<
  DeliverRepliesParams,
  "chatId" | "token" | "replyToMode" | "textLimit"
> &
  Partial<Pick<DeliverRepliesParams, "replyToMode" | "textLimit" | "mediaLoader">>;
type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    probeVideoDimensions,
  };
});

vi.mock("openclaw/plugin-sdk/hook-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/hook-runtime")>();
  return {
    ...actual,
    triggerInternalHook,
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: () => messageHookRunner,
  };
});

vi.resetModules();
const { deliverReplies } = await import("./delivery.js");
const { sendTelegramText } = await import("./delivery.send.js");

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

function createRuntime(withLog = true): RuntimeStub {
  return {
    error: vi.fn(),
    log: withLog ? vi.fn() : vi.fn(),
    exit: vi.fn(),
  };
}

function createBot(api: Record<string, unknown> = {}): Bot {
  const raw = {
    sendRichMessage: vi.fn(
      (params: {
        chat_id: string | number;
        rich_message: { markdown?: string; html?: string; skip_entity_detection?: boolean };
        [key: string]: unknown;
      }) => {
        const sendMessage = api.sendMessage;
        if (typeof sendMessage !== "function") {
          throw new Error("sendMessage mock missing");
        }
        const { chat_id, rich_message, ...richParams } = params;
        const sendParams: Record<string, unknown> = {
          parse_mode: "HTML",
          ...(rich_message.skip_entity_detection === true ? { skip_entity_detection: true } : {}),
          ...richParams,
        };
        const text = rich_message.markdown ?? rich_message.html ?? "";
        const replyParameters = sendParams.reply_parameters;
        if (
          replyParameters &&
          typeof replyParameters === "object" &&
          !("quote" in replyParameters) &&
          typeof (replyParameters as { message_id?: unknown }).message_id === "number"
        ) {
          sendParams.reply_to_message_id = (replyParameters as { message_id: number }).message_id;
          sendParams.allow_sending_without_reply = true;
          delete sendParams.reply_parameters;
        }
        const options = sendParams;
        return sendMessage(chat_id, text, options);
      },
    ),
  };
  return { api: { ...api, raw } } as unknown as Bot;
}

async function deliverWith(params: DeliverWithParams) {
  return await deliverReplies({
    ...baseDeliveryParams,
    ...params,
    mediaLoader: params.mediaLoader ?? loadWebMedia,
  });
}

function mockMediaLoad(fileName: string, contentType: string, data: string) {
  loadWebMedia.mockResolvedValueOnce({
    buffer: Buffer.from(data),
    contentType,
    fileName,
  });
}

function createObservedPromptContextSequence(
  record: (value: unknown) => void,
  source?: { transcriptMessageId: string },
) {
  return createTelegramPromptContextProjectionSequence({
    ...(source ? { source } : {}),
    record: async (value) => {
      record(value);
      return true;
    },
  });
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function firstMockCallArg(mock: ReturnType<typeof vi.fn>, argIndex: number) {
  return mockCallArg(mock, 0, argIndex);
}

function firstSendText(mock: ReturnType<typeof vi.fn>) {
  const text = firstMockCallArg(mock, 1);
  expect(text).toBeTypeOf("string");
  return text as string;
}

function createSendMessageHarness(messageId = 4) {
  const runtime = createRuntime();
  const sendMessage = vi.fn().mockResolvedValue({
    message_id: messageId,
    chat: { id: "123" },
  });
  const bot = createBot({ sendMessage });
  return { runtime, sendMessage, bot };
}

function createVoiceMessagesForbiddenError() {
  return new Error(
    "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
  );
}

function createThreadNotFoundError(operation = "sendMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: message thread not found)`,
  );
}

function createQuoteNotFoundError(operation = "sendMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: quote not found)`,
  );
}

function createQuoteTextInvalidError(operation = "sendMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: QUOTE_TEXT_INVALID)`,
  );
}

function createNormalizedQuoteTextInvalidError(operation = "sendMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: quote text invalid)`,
  );
}

function createRichEntityInvalidError(entity = "EMAIL", operation = "sendRichMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: RICH_MESSAGE_${entity}_INVALID)`,
  );
}

function createRichContentRequiredError(operation = "sendRichMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: RICH_MESSAGE_CONTENT_REQUIRED)`,
  );
}

function createHtmlParseError(operation = "sendMessage") {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: can't parse entities: Can't find end of the entity)`,
  );
}

function createWrappedConnectTimeoutHttpError(operation = "sendMessage") {
  const root = Object.assign(new Error("Connect Timeout Error"), {
    name: "ConnectTimeoutError",
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  const fetchError = Object.assign(new TypeError("fetch failed"), { cause: root });
  return Object.assign(new Error(`Network request for '${operation}' failed!`), {
    name: "HttpError",
    error: fetchError,
  });
}

function createPlainHttpError(operation = "sendMessage") {
  return Object.assign(new Error(`Network request for '${operation}' failed!`), {
    name: "HttpError",
    error: new TypeError("fetch failed"),
  });
}

function createVoiceFailureHarness(params: {
  voiceError: Error;
  sendMessageResult?: { message_id: number; chat: { id: string } };
}) {
  const runtime = createRuntime();
  const sendVoice = vi.fn().mockRejectedValue(params.voiceError);
  const sendMessage = params.sendMessageResult
    ? vi.fn().mockResolvedValue(params.sendMessageResult)
    : vi.fn();
  const bot = createBot({ sendVoice, sendMessage });
  return { runtime, sendVoice, sendMessage, bot };
}

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockClear();
    probeVideoDimensions.mockReset();
    probeVideoDimensions.mockResolvedValue(undefined);
    triggerInternalHook.mockReset();
    messageHookRunner.hasHooks.mockReset();
    messageHookRunner.hasHooks.mockReturnValue(false);
    messageHookRunner.runMessageSending.mockReset();
    messageHookRunner.runMessageSent.mockReset();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = createRuntime(false);

    await deliverWith({
      replies: [{ audioAsVoice: true }],
      runtime,
      bot: createBot(),
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("skips malformed replies and continues with valid entries", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [undefined, { text: "hello" }] as unknown as DeliverRepliesParams["replies"],
      runtime,
      bot,
    });

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 1)).toBe("hello");
  });

  it("delivers prepared HTML without reparsing visible syntax as Markdown", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const records: unknown[] = [];
    const promptContextSequence = createObservedPromptContextSequence((record) =>
      records.push(record),
    );

    await deliverWith({
      replies: [{ text: "<code>&lt;b&gt;x&lt;/b&gt;</code>" }],
      runtime,
      bot: createBot({ sendMessage }),
      textMode: "html",
      promptContextSequence,
    });
    await promptContextSequence.finish();

    expect(firstMockCallArg(sendMessage, 1)).toBe("<code>&lt;b&gt;x&lt;/b&gt;</code>");
    expectRecordFields(firstMockCallArg(sendMessage, 2), { parse_mode: "HTML" });
    expect(records).toEqual([{ messageId: 1, text: "<b>x</b>" }]);
  });

  it("applies reaction-only replies without logging missing text/media", async () => {
    const runtime = createRuntime(false);
    const setMessageReaction = vi.fn().mockResolvedValue(true);
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage, setMessageReaction });

    await deliverWith({
      replies: [
        {
          replyToId: "456",
          channelData: {
            telegram: {
              reaction: { emoji: "🔥" },
            },
          },
        },
      ],
      replyToMode: "all",
      runtime,
      bot,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, [{ type: "emoji", emoji: "🔥" }]);
  });

  it("does not mark rejected reaction-only replies as delivered", async () => {
    const runtime = createRuntime(false);
    const setMessageReaction = vi.fn().mockRejectedValue(new Error("REACTION_INVALID"));
    const bot = createBot({ sendMessage: vi.fn(), setMessageReaction });

    const result = await deliverWith({
      replies: [
        {
          replyToId: "456",
          channelData: { telegram: { reaction: { emoji: "not-supported" } } },
        },
      ],
      replyToMode: "all",
      runtime,
      bot,
    });

    expect(result).toEqual({ delivered: false });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Reaction unavailable"));
  });

  it("does not send text when a reaction reply has no target", async () => {
    const runtime = createRuntime(false);
    const setMessageReaction = vi.fn();
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage, setMessageReaction });

    const result = await deliverWith({
      replies: [
        {
          text: "Done",
          replyToId: "456",
          channelData: { telegram: { reaction: { emoji: "🔥" } } },
        },
      ],
      replyToMode: "off",
      runtime,
      bot,
    });

    expect(result).toEqual({ delivered: false });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("requires a reply target"));
    expect(setMessageReaction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send text when Telegram rejects the reaction", async () => {
    const runtime = createRuntime(false);
    const setMessageReaction = vi.fn().mockRejectedValue(new Error("REACTION_INVALID"));
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage, setMessageReaction });

    const result = await deliverWith({
      replies: [
        {
          text: "Done",
          replyToId: "456",
          channelData: { telegram: { reaction: { emoji: "not-supported" } } },
        },
      ],
      replyToMode: "all",
      runtime,
      bot,
    });

    expect(result).toEqual({ delivered: false });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Reaction unavailable"));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("mirrors delivered replies once after successful sends", async () => {
    const runtime = createRuntime(false);
    const transcriptMirror = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "hello" }, { text: "world" }],
      runtime,
      bot,
      transcriptMirror,
    });

    expect(transcriptMirror).toHaveBeenCalledOnce();
    expect(transcriptMirror).toHaveBeenCalledWith({ text: "hello\n\nworld", mediaUrls: undefined });
  });

  it("renders shared interactive reply buttons as Telegram inline buttons", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 2, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [
        {
          text: "Plugin bind approval required",
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Allow once", value: "pluginbind:req:o", style: "success" },
                  { label: "Always allow", value: "pluginbind:req:a", style: "primary" },
                  { label: "Deny", value: "pluginbind:req:d", style: "danger" },
                ],
              },
            ],
          },
        },
      ],
      runtime,
      bot,
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toBe("Plugin bind approval required");
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Allow once", callback_data: "pluginbind:req:o", style: "success" },
            { text: "Always allow", callback_data: "pluginbind:req:a", style: "primary" },
            { text: "Deny", callback_data: "pluginbind:req:d", style: "danger" },
          ],
        ],
      },
    });
  });

  it("uses interactive button labels as fallback text for button-only replies", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 3, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [
        {
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "cmd:retry" }] }],
          },
        },
      ],
      runtime,
      bot,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toContain("Retry");
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_markup: {
        inline_keyboard: [[{ text: "Retry", callback_data: "cmd:retry" }]],
      },
    });
  });

  it("keeps presentation-only controls deliverable without duplicating button labels", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 4, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [
        {
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "cmd:retry" }] }],
          },
        },
      ],
      runtime,
      bot,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toBe("Choose an option.");
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_markup: {
        inline_keyboard: [[{ text: "Retry", callback_data: "cmd:retry" }]],
      },
    });
  });

  it("keeps native Telegram button-only replies deliverable", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 5, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [
        {
          channelData: {
            telegram: {
              buttons: [[{ text: "Retry", callback_data: "cmd:retry" }]],
            },
          },
        },
      ],
      runtime,
      bot,
    });

    expect(runtime.error).not.toHaveBeenCalled();
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toBe("Choose an option.");
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_markup: {
        inline_keyboard: [[{ text: "Retry", callback_data: "cmd:retry" }]],
      },
    });
  });

  it("appends presentation tables to top-level text exactly once", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 5, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [
        {
          text: "Quarterly results",
          presentation: {
            title: "FY25 outlook",
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Stage"],
                rows: [["Acme", "Won"]],
              },
            ],
          },
        },
      ],
      runtime,
      bot,
    });

    expect(firstMockCallArg(sendMessage, 1)).toBe(
      "Quarterly results\n\nFY25 outlook\n\nPipeline (table)\n\n• Account: Acme; Stage: Won",
    );
  });

  it("reports message_sent success=false when hooks blank out a text-only reply", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending" || name === "message_sent",
    );
    messageHookRunner.runMessageSending.mockResolvedValue({ content: "   " });

    const runtime = createRuntime(false);
    const sendMessage = vi.fn();
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "hello" }],
      runtime,
      bot,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSent, 0, 0), {
      success: false,
      content: "   ",
    });
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSent, 0, 1), {
      channelId: "telegram",
      conversationId: "123",
    });
  });

  it("passes accountId into message hooks", async () => {
    messageHookRunner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending" || name === "message_sent",
    );

    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 9, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      accountId: "work",
      replies: [{ text: "hello" }],
      runtime,
      bot,
    });

    if (mockCallArg(messageHookRunner.runMessageSending, 0, 0) === undefined) {
      throw new Error("Expected message_sending hook payload");
    }
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSending, 0, 1), {
      channelId: "telegram",
      accountId: "work",
      conversationId: "123",
    });
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSent, 0, 0), { success: true });
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSent, 0, 1), {
      channelId: "telegram",
      accountId: "work",
      conversationId: "123",
    });
  });

  it("sets disable_notification when silent is true", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 5,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "hello" }],
      runtime,
      bot,
      silent: true,
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), { disable_notification: true });
  });

  it("emits internal message:sent when session hook context is available", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 9, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      sessionKeyForInternalHooks: "agent:test:telegram:123",
      mirrorIsGroup: true,
      mirrorGroupId: "123",
      replies: [{ text: "hello" }],
      runtime,
      bot,
    });

    const hookPayload = expectRecordFields(mockCallArg(triggerInternalHook, 0, 0), {
      type: "message",
      action: "sent",
      sessionKey: "agent:test:telegram:123",
    });
    expectRecordFields(hookPayload.context, {
      to: "123",
      content: "hello",
      success: true,
      channelId: "telegram",
      conversationId: "123",
      messageId: "9",
      isGroup: true,
      groupId: "123",
    });
  });

  it("does not emit internal message:sent without a session key", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "hello" }],
      runtime,
      bot,
    });

    expect(triggerInternalHook).not.toHaveBeenCalled();
  });

  it("suppresses exact NO_REPLY for direct Telegram sessions", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 12, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      sessionKeyForInternalHooks: "agent:test:telegram:direct:123",
      replies: [{ text: "NO_REPLY" }],
      runtime,
      bot,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses the policy session key when suppressing exact NO_REPLY", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 121, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      sessionKeyForInternalHooks: "agent:test:telegram:slash:123",
      policySessionKey: "agent:test:telegram:direct:123",
      replies: [{ text: "NO_REPLY" }],
      runtime,
      bot,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses exact NO_REPLY for group Telegram sessions", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 13, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      sessionKeyForInternalHooks: "agent:test:telegram:group:123",
      replies: [{ text: "NO_REPLY" }],
      runtime,
      bot,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("emits internal message:sent with success=false on delivery failure", async () => {
    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockRejectedValue(new Error("network error"));
    const bot = createBot({ sendMessage });

    await expect(
      deliverWith({
        sessionKeyForInternalHooks: "agent:test:telegram:123",
        replies: [{ text: "hello" }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("network error");

    const hookPayload = expectRecordFields(mockCallArg(triggerInternalHook, 0, 0), {
      type: "message",
      action: "sent",
      sessionKey: "agent:test:telegram:123",
    });
    expectRecordFields(hookPayload.context, {
      to: "123",
      content: "hello",
      success: false,
      error: "network error",
      channelId: "telegram",
      conversationId: "123",
    });
  });

  it("passes media metadata to message_sending hooks", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sending");

    const runtime = createRuntime(false);
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 2, chat: { id: "123" } });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ text: "caption", mediaUrl: "https://example.com/photo.jpg" }],
      runtime,
      bot,
    });

    const sendingPayload = expectRecordFields(
      mockCallArg(messageHookRunner.runMessageSending, 0, 0),
      {
        to: "123",
        content: "caption",
      },
    );
    expectRecordFields(sendingPayload.metadata, {
      channel: "telegram",
      mediaUrls: ["https://example.com/photo.jpg"],
    });
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSending, 0, 1), {
      channelId: "telegram",
      conversationId: "123",
    });
  });

  it("passes shared routing fields to message_sending hooks", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sending");

    const runtime = createRuntime(false);
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 3, chat: { id: "123" } });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "caption", replyToId: "500" }],
      runtime,
      bot,
      replyToMode: "all",
      thread: { id: 42, scope: "forum" },
    });

    const sendingPayload = expectRecordFields(
      mockCallArg(messageHookRunner.runMessageSending, 0, 0),
      {
        to: "123",
        content: "caption",
        replyToId: 500,
        threadId: 42,
      },
    );
    expectRecordFields(sendingPayload.metadata, {
      channel: "telegram",
      threadId: 42,
    });
    expectRecordFields(mockCallArg(messageHookRunner.runMessageSending, 0, 1), {
      channelId: "telegram",
      conversationId: "123",
    });
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = createRuntime(false);
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { message_id: 1, chat: { id: "123" } };
    });
    const bot = createBot({ sendVoice });
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
      runtime,
      bot,
      onVoiceRecording,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("renders markdown in media captions", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      runtime,
      bot,
    });

    expect(firstMockCallArg(sendPhoto, 0)).toBe("123");
    if (firstMockCallArg(sendPhoto, 1) === undefined) {
      throw new Error("Expected Telegram photo media");
    }
    expectRecordFields(mockCallArg(sendPhoto, 0, 2), {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
    });
  });

  it("falls back to a plain media caption when Telegram rejects caption HTML", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(createHtmlParseError("sendPhoto"))
      .mockResolvedValueOnce({
        message_id: 3,
        chat: { id: "123" },
      });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      runtime,
      bot,
    });

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(sendPhoto, 0, 2), {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
    });
    expectRecordFields(mockCallArg(sendPhoto, 1, 2), {
      caption: "hi **boss**",
    });
    expect(mockCallArg(sendPhoto, 1, 2)).not.toHaveProperty("parse_mode");
  });

  it("passes probed dimensions to video reply sends", async () => {
    const runtime = createRuntime();
    const sendVideo = vi.fn().mockResolvedValue({
      message_id: 22,
      chat: { id: "123" },
    });
    const bot = createBot({ sendVideo });
    probeVideoDimensions.mockResolvedValueOnce({ width: 720, height: 1280 });

    mockMediaLoad("video.mp4", "video/mp4", "video");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/video.mp4", text: "hi **boss**" }],
      runtime,
      bot,
    });

    expect(probeVideoDimensions).toHaveBeenCalledWith(Buffer.from("video"));
    expect(firstMockCallArg(sendVideo, 0)).toBe("123");
    if (firstMockCallArg(sendVideo, 1) === undefined) {
      throw new Error("Expected Telegram video media");
    }
    expectRecordFields(mockCallArg(sendVideo, 0, 2), {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
      width: 720,
      height: 1280,
    });
  });

  it("does not probe GIF reply animations", async () => {
    const runtime = createRuntime();
    const sendAnimation = vi.fn().mockResolvedValue({
      message_id: 23,
      chat: { id: "123" },
    });
    const bot = createBot({ sendAnimation });

    mockMediaLoad("fun.gif", "image/gif", "GIF89a");

    await deliverWith({
      replies: [{ mediaUrl: "https://example.com/fun.gif", text: "gif" }],
      runtime,
      bot,
    });

    expect(probeVideoDimensions).not.toHaveBeenCalled();
    expect(firstMockCallArg(sendAnimation, 0)).toBe("123");
    if (firstMockCallArg(sendAnimation, 1) === undefined) {
      throw new Error("Expected Telegram animation media");
    }
    const options = mockCallArg(sendAnimation, 0, 2) as Record<string, unknown>;
    expect(typeof options.width).not.toBe("number");
    expect(typeof options.height).not.toBe("number");
  });

  it("passes mediaLocalRoots to media loading", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });
    const mediaLocalRoots = ["/tmp/workspace-work"];

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverWith({
      replies: [{ mediaUrl: "/tmp/workspace-work/photo.jpg" }],
      runtime,
      bot,
      mediaLocalRoots,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/workspace-work/photo.jpg", {
      localRoots: mediaLocalRoots,
    });
  });

  it("passes the configured media byte cap to media loading", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 13,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });
    const mediaMaxBytes = 50 * 1024 * 1024;

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await deliverReplies({
      replies: [{ mediaUrl: "https://example.com/photo.jpg" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      mediaMaxBytes,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("https://example.com/photo.jpg", {
      maxBytes: mediaMaxBytes,
    });
  });

  it("disables link previews without rich-only entity flags", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Check https://example.com" }],
      runtime,
      bot,
      linkPreview: false,
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      link_preview_options: { is_disabled: true },
    });
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("skip_entity_detection");
  });

  it("includes message_thread_id for DM topics", async () => {
    const { runtime, sendMessage, bot } = createSendMessageHarness();

    await deliverWith({
      replies: [{ text: "Hello" }],
      runtime,
      bot,
      thread: { id: 42, scope: "dm" },
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), { message_thread_id: 42 });
  });

  it("does not retry DM topic sends without the topic id when the topic is missing", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockRejectedValueOnce(createThreadNotFoundError("sendMessage"));
    const bot = createBot({ sendMessage });

    await expect(
      deliverWith({
        replies: [{ text: "hello" }],
        runtime,
        bot,
        thread: { id: 42, scope: "dm" },
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), { message_thread_id: 42 });
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("does not retry forum sends without message_thread_id", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockRejectedValue(createThreadNotFoundError("sendMessage"));
    const bot = createBot({ sendMessage });

    await expect(
      deliverWith({
        replies: [{ text: "hello" }],
        runtime,
        bot,
        thread: { id: 42, scope: "forum" },
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("retries final text sends for wrapped Undici connect timeouts", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(createWrappedConnectTimeoutHttpError("sendMessage"))
      .mockResolvedValueOnce({
        message_id: 12,
        chat: { id: "123" },
      });
    const bot = createBot({ sendMessage });

    const delivered = deliverWith({
      replies: [{ text: "hello" }],
      runtime,
      bot,
    });
    await vi.runAllTimersAsync();
    await delivered;

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.error).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not retry final text sends for plain grammY envelopes without a safe cause", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockRejectedValue(createPlainHttpError("sendMessage"));
    const bot = createBot({ sendMessage });

    await expect(
      deliverWith({
        replies: [{ text: "hello" }],
        runtime,
        bot,
      }),
    ).rejects.toThrow(/Network request for 'sendMessage' failed!/);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("does not retry DM topic media sends without the topic id", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockRejectedValueOnce(createThreadNotFoundError("sendPhoto"));
    const bot = createBot({ sendPhoto });

    mockMediaLoad("photo.jpg", "image/jpeg", "image");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "caption" }],
        runtime,
        bot,
        thread: { id: 42, scope: "dm" },
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(sendPhoto, 0, 2), { message_thread_id: 42 });
    expect(runtime.error).toHaveBeenCalledTimes(1);
  });

  it("does not include link_preview_options when linkPreview is true", async () => {
    const { runtime, sendMessage, bot } = createSendMessageHarness();

    await deliverWith({
      replies: [{ text: "Check https://example.com" }],
      runtime,
      bot,
      linkPreview: true,
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("link_preview_options");
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("skip_entity_detection");
  });

  it("skips whitespace-only text replies without calling Telegram", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn();
    const bot = { api: { sendMessage } } as unknown as Bot;

    await expect(
      deliverReplies({
        replies: [{ text: "   " }],
        chatId: "123",
        token: "tok",
        runtime,
        bot,
        replyToMode: "off",
        textLimit: 4000,
      }),
    ).resolves.toEqual({ delivered: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses reply_parameters when quote text is provided", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "500" }],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteMessageId: 500,
      replyQuoteText: " quoted text\n",
      replyQuotePosition: 17,
      replyQuoteEntities: [{ type: "bold", offset: 0, length: 6 }],
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_parameters: {
        message_id: 500,
        quote: " quoted text\n",
        quote_position: 17,
        quote_entities: [{ type: "bold", offset: 0, length: 6 }],
        allow_sending_without_reply: true,
      },
    });
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_to_message_id");
  });

  it("uses the native quote candidate that matches each reply target", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [
        { text: "First", replyToId: "500" },
        { text: "Second", replyToId: "501" },
      ],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteByMessageId: {
        "500": { text: "first quote", position: 0 },
        "501": { text: "second quote", position: 0 },
      },
    });

    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_parameters: {
        message_id: 500,
        quote: "first quote",
        quote_position: 0,
        allow_sending_without_reply: true,
      },
    });
    expectRecordFields(mockCallArg(sendMessage, 1, 2), {
      reply_parameters: {
        message_id: 501,
        quote: "second quote",
        quote_position: 0,
        allow_sending_without_reply: true,
      },
    });
  });

  it("retries with legacy reply id when native quote parameters are rejected", async () => {
    for (const createError of [
      createQuoteNotFoundError,
      createQuoteTextInvalidError,
      createNormalizedQuoteTextInvalidError,
    ]) {
      const runtime = createRuntime();
      const sendMessage = vi
        .fn()
        .mockRejectedValueOnce(createError())
        .mockResolvedValueOnce({
          message_id: 11,
          chat: { id: "123" },
        });
      const bot = createBot({ sendMessage });

      await deliverWith({
        replies: [{ text: "Hello there", replyToId: "500" }],
        runtime,
        bot,
        replyToMode: "all",
        replyQuoteMessageId: 500,
        replyQuoteText: " quoted text\n",
      });

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expectRecordFields(mockCallArg(sendMessage, 0, 2), {
        reply_parameters: {
          message_id: 500,
          quote: " quoted text\n",
          allow_sending_without_reply: true,
        },
      });
      expectRecordFields(mockCallArg(sendMessage, 1, 2), {
        reply_to_message_id: 500,
        allow_sending_without_reply: true,
      });
      expect(mockCallArg(sendMessage, 1, 2)).not.toHaveProperty("reply_parameters");
    }
  });

  it("retries rich messages without converting reply parameters to legacy fields", async () => {
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(createQuoteNotFoundError())
      .mockResolvedValueOnce({
        message_id: 11,
        chat: { id: "123" },
      });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "500" }],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteMessageId: 500,
      replyQuoteText: " quoted text\n",
      richMessages: true,
    });

    const raw = bot.api.raw as unknown as {
      sendRichMessage: ReturnType<typeof vi.fn>;
    };
    const { sendRichMessage } = raw;
    expect(sendRichMessage).toHaveBeenCalledTimes(2);
    expectRecordFields(firstMockCallArg(sendRichMessage, 0), {
      reply_parameters: {
        message_id: 500,
        quote: " quoted text\n",
        allow_sending_without_reply: true,
      },
    });
    expectRecordFields(mockCallArg(sendRichMessage, 1, 0), {
      reply_parameters: {
        message_id: 500,
        allow_sending_without_reply: true,
      },
    });
    expect(mockCallArg(sendRichMessage, 1, 0)).not.toHaveProperty("reply_to_message_id");
  });

  it("skips rich entity detection for reply text with provider-prefixed email addresses", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });
    const oauthProfileText =
      "OAuth profile: openai:keshavbotagent@gmail.com (keshavbotagent@gmail.com)";

    await deliverWith({
      replies: [{ text: oauthProfileText }],
      runtime,
      bot,
      richMessages: true,
    });

    const raw = bot.api.raw as unknown as {
      sendRichMessage: ReturnType<typeof vi.fn>;
    };
    const richMessage = raw.sendRichMessage.mock.calls[0]?.[0]?.rich_message;
    expect(richMessage).toEqual({
      html: oauthProfileText,
      skip_entity_detection: true,
    });
  });

  it("falls back to plain text when a rich message is rejected for an invalid entity", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });
    (bot.api.raw as unknown as { sendRichMessage: ReturnType<typeof vi.fn> }).sendRichMessage = vi
      .fn()
      .mockRejectedValue(createRichEntityInvalidError("EMAIL"));
    const text = "Status includes openai:owner@example.com";

    await deliverWith({
      replies: [{ text }],
      runtime,
      bot,
      richMessages: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toBe(text);
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("parse_mode");
  });

  it("falls back to plain text when a rich message is rejected for empty rich content", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 15,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });
    (bot.api.raw as unknown as { sendRichMessage: ReturnType<typeof vi.fn> }).sendRichMessage = vi
      .fn()
      .mockRejectedValue(createRichContentRequiredError());
    const text = "delivery continues as plain text";

    await deliverWith({
      replies: [{ text }],
      runtime,
      bot,
      richMessages: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toBe(text);
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("parse_mode");
  });

  it("falls back to plain text before raw rich send when rich markdown renders empty", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 16,
      chat: { id: "123" },
    });
    const sendRichMessage = vi.fn();
    const bot = createBot({ sendMessage });
    Object.assign(bot.api.raw, { sendRichMessage });

    const messageId = await sendTelegramText(bot, "123", "#", runtime, {
      richMessages: true,
      textMode: "markdown",
    });

    expect(messageId).toBe(16);
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toBe("#");
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("parse_mode");
  });

  it("uses table-aware plain text when rich reply fallback sends", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });
    (bot.api.raw as unknown as { sendRichMessage: ReturnType<typeof vi.fn> }).sendRichMessage = vi
      .fn()
      .mockRejectedValue(createRichEntityInvalidError("URL"));
    const text = "| Rank | Model | Score |\n| --- | --- | --- |\n| 4 | Claude Opus | 78.16% |";

    await deliverWith({
      replies: [{ text }],
      runtime,
      bot,
      richMessages: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 1)).toBe("Rank | Model | Score\n4 | Claude Opus | 78.16%");
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("rich-degrade=plain-fallback:rich-entity-invalid"),
    );
  });

  it("falls back to plain text for other invalid rich entity validation errors", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 13,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });
    (bot.api.raw as unknown as { sendRichMessage: ReturnType<typeof vi.fn> }).sendRichMessage = vi
      .fn()
      .mockRejectedValue(createRichEntityInvalidError("URL"));
    const text = "Status with a rejected URL entity";

    await deliverWith({
      replies: [{ text }],
      runtime,
      bot,
      richMessages: true,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 1)).toBe(text);
  });

  it("does not fall back to plain text for non-validation rich message errors", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 14,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });
    (bot.api.raw as unknown as { sendRichMessage: ReturnType<typeof vi.fn> }).sendRichMessage = vi
      .fn()
      .mockRejectedValue(new Error("network error"));
    const text = "Status text";

    await expect(
      deliverWith({
        replies: [{ text }],
        runtime,
        bot,
        richMessages: true,
      }),
    ).rejects.toThrow("network error");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses legacy reply id when selected reply target differs from quote source", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "501" }],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteMessageId: 500,
      replyQuoteText: "quoted text",
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_to_message_id: 501,
      allow_sending_without_reply: true,
    });
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_parameters");
  });

  it("omits native quote parameters when reply mode suppresses the reply", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 13,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "500" }],
      runtime,
      bot,
      replyToMode: "off",
      replyQuoteMessageId: 500,
      replyQuoteText: "quoted text",
    });

    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_parameters");
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_to_message_id");
  });

  it("uses legacy reply id when quote text has no quoted message id", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverWith({
      replies: [{ text: "Hello there", replyToId: "501" }],
      runtime,
      bot,
      replyToMode: "all",
      replyQuoteText: "quoted text",
    });

    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    firstSendText(sendMessage);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_to_message_id: 501,
      allow_sending_without_reply: true,
    });
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_parameters");
  });

  it("falls back to text when sendVoice fails with VOICE_MESSAGES_FORBIDDEN", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
      sendMessageResult: {
        message_id: 5,
        chat: { id: "123" },
      },
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "Hello there", audioAsVoice: true },
      ],
      runtime,
      bot,
    });

    // Voice was attempted but failed
    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Fallback to text succeeded
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toContain("Hello there");
    if (firstMockCallArg(sendMessage, 2) === undefined) {
      throw new Error("Expected Telegram fallback text options");
    }
  });

  it("uses spokenText only after voice rejection", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
      sendMessageResult: {
        message_id: 5,
        chat: { id: "123" },
      },
    });
    const transcriptMirror = vi.fn();

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        {
          mediaUrl: "https://example.com/note.ogg",
          audioAsVoice: true,
          spokenText: "Hidden voice fallback",
        },
      ],
      runtime,
      bot,
      transcriptMirror,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 1)).toContain("Hidden voice fallback");
    expect(transcriptMirror).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hidden voice fallback" }),
    );
  });

  it("runs message_sending hooks over spokenText voice fallback content", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sending");
    messageHookRunner.runMessageSending.mockResolvedValue({ content: "Rewritten voice fallback" });
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
      sendMessageResult: {
        message_id: 5,
        chat: { id: "123" },
      },
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        {
          mediaUrl: "https://example.com/note.ogg",
          audioAsVoice: true,
          spokenText: "Hidden voice fallback",
        },
      ],
      runtime,
      bot,
    });

    expectRecordFields(mockCallArg(messageHookRunner.runMessageSending, 0, 0), {
      content: "Hidden voice fallback",
    });
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect((firstMockCallArg(sendVoice, 2) as { caption?: unknown }).caption).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 1)).toContain("Rewritten voice fallback");
  });

  it("does not render spokenText as a successful voice caption", async () => {
    const runtime = createRuntime(false);
    const sendVoice = vi.fn().mockResolvedValue({ message_id: 8, chat: { id: "123" } });
    const bot = createBot({ sendVoice });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        {
          mediaUrl: "https://example.com/note.ogg",
          audioAsVoice: true,
          spokenText: "Hidden voice fallback",
        },
      ],
      runtime,
      bot,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect((firstMockCallArg(sendVoice, 2) as { caption?: unknown }).caption).toBeUndefined();
  });

  it("keeps disable_notification on voice fallback text when silent is true", async () => {
    const runtime = createRuntime();
    const sendVoice = vi.fn().mockRejectedValue(createVoiceMessagesForbiddenError());
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 5,
      chat: { id: "123" },
    });
    const bot = createBot({ sendVoice, sendMessage });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "Hello there", audioAsVoice: true },
      ],
      runtime,
      bot,
      silent: true,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(firstMockCallArg(sendMessage, 0)).toBe("123");
    expect(firstMockCallArg(sendMessage, 1)).toContain("Hello there");
    expectRecordFields(mockCallArg(sendMessage, 0, 2), { disable_notification: true });
  });

  it("voice fallback avoids native replies for chunked first-mode fallback text", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
      sendMessageResult: {
        message_id: 6,
        chat: { id: "123" },
      },
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        {
          mediaUrl: "https://example.com/note.ogg",
          text: "chunk-one\n\nchunk-two",
          replyToId: "77",
          audioAsVoice: true,
          channelData: {
            telegram: {
              buttons: [[{ text: "Ack", callback_data: "ack" }]],
            },
          },
        },
      ],
      runtime,
      bot,
      replyToMode: "first",
      replyQuoteMessageId: 77,
      replyQuoteText: "quoted context",
      textLimit: 12,
    });

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_markup: {
        inline_keyboard: [[{ text: "Ack", callback_data: "ack" }]],
      },
    });
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_to_message_id");
    expect(mockCallArg(sendMessage, 0, 2)).not.toHaveProperty("reply_parameters");
    expect(mockCallArg(sendMessage, 1, 2)).not.toHaveProperty("reply_to_message_id", 77);
    expect(mockCallArg(sendMessage, 1, 2)).not.toHaveProperty("reply_parameters");
    expect(mockCallArg(sendMessage, 1, 2)).not.toHaveProperty("reply_markup");
  });

  it("rethrows non-VOICE_MESSAGES_FORBIDDEN errors from sendVoice", async () => {
    const runtime = createRuntime();
    const sendVoice = vi.fn().mockRejectedValue(new Error("Network error"));
    const sendMessage = vi.fn();
    const bot = createBot({ sendVoice, sendMessage });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/note.ogg", text: "Hello", audioAsVoice: true }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("Network error");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Text fallback should NOT be attempted for other errors
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("replyToMode 'first' keeps native reply-to for a single text chunk", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 20,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverReplies({
      replies: [{ text: "one chunk", replyToId: "700" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "first",
      textLimit: 4000,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(sendMessage, 0, 2), {
      reply_to_message_id: 700,
      allow_sending_without_reply: true,
    });
  });

  it("replyToMode 'first' avoids native reply-to for chunked text", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 20,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    // Use a small textLimit to force multiple chunks
    await deliverReplies({
      replies: [{ text: "chunk-one\n\nchunk-two", replyToId: "700" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "first",
      textLimit: 12,
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of sendMessage.mock.calls) {
      expect(call[2]).not.toHaveProperty("reply_to_message_id");
      expect(call[2]).not.toHaveProperty("reply_parameters");
    }
  });

  it("clamps reply chunks to Telegram rich message limit", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 21,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverReplies({
      replies: [{ text: "A".repeat(40_000) }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 100_000,
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessage.mock.calls.every((call) => String(call[1]).length <= 32_768)).toBe(true);
  });

  it("replyToMode 'all' applies reply-to to every text chunk", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 21,
      chat: { id: "123" },
    });
    const bot = createBot({ sendMessage });

    await deliverReplies({
      replies: [{ text: "chunk-one\n\nchunk-two", replyToId: "800" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "all",
      textLimit: 12,
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Both chunks should have reply_to_message_id
    for (const call of sendMessage.mock.calls) {
      expectRecordFields(call[2], {
        reply_to_message_id: 800,
        allow_sending_without_reply: true,
      });
    }
  });

  it("replyToMode 'first' only applies reply-to to first media item", async () => {
    const runtime = createRuntime();
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 30,
      chat: { id: "123" },
    });
    const bot = createBot({ sendPhoto });

    mockMediaLoad("a.jpg", "image/jpeg", "img1");
    mockMediaLoad("b.jpg", "image/jpeg", "img2");

    await deliverReplies({
      replies: [{ mediaUrls: ["https://a.jpg", "https://b.jpg"], replyToId: "900" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "first",
      textLimit: 4000,
    });

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    // First media should have reply_to_message_id
    expectRecordFields(mockCallArg(sendPhoto, 0, 2), {
      reply_to_message_id: 900,
      allow_sending_without_reply: true,
    });
    // Second media should NOT have reply_to_message_id
    expect(mockCallArg(sendPhoto, 1, 2)).not.toHaveProperty("reply_to_message_id");
  });

  it("pins the first delivered text message when telegram pin is requested", async () => {
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 101, chat: { id: "123" } })
      .mockResolvedValueOnce({ message_id: 102, chat: { id: "123" } });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const bot = createBot({ sendMessage, pinChatMessage });

    await deliverReplies({
      replies: [{ text: "chunk-one\n\nchunk-two", delivery: { pin: true } }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 12,
    });

    expect(pinChatMessage).toHaveBeenCalledTimes(1);
    expect(pinChatMessage).toHaveBeenCalledWith("123", 101, { disable_notification: true });
  });

  it("honors notify on reply delivery pins", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 101, chat: { id: "123" } });
    const pinChatMessage = vi.fn().mockResolvedValue(true);
    const bot = createBot({ sendMessage, pinChatMessage });

    await deliverReplies({
      replies: [{ text: "hello", delivery: { pin: { enabled: true, notify: true } } }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4096,
    });

    expect(pinChatMessage).toHaveBeenCalledWith("123", 101, { disable_notification: false });
  });

  it("continues when pinning fails", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 201, chat: { id: "123" } });
    const pinChatMessage = vi.fn().mockRejectedValue(new Error("pin failed"));
    const bot = createBot({ sendMessage, pinChatMessage });

    await deliverWith({
      replies: [{ text: "hello", delivery: { pin: true } }],
      runtime,
      bot,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(pinChatMessage).toHaveBeenCalledTimes(1);
  });

  it("rethrows VOICE_MESSAGES_FORBIDDEN when no text fallback is available", async () => {
    const { runtime, sendVoice, sendMessage, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
    });

    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await expect(
      deliverWith({
        replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
        runtime,
        bot,
      }),
    ).rejects.toThrow("VOICE_MESSAGES_FORBIDDEN");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("detaches prompt-context provenance when message_sending rewrites content", async () => {
    messageHookRunner.hasHooks.mockImplementation((name: string) => name === "message_sending");
    messageHookRunner.runMessageSending.mockResolvedValue({ content: "rewritten" });
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 304, chat: { id: "123" } });
    const observer = vi.fn();
    const promptContextSequence = createObservedPromptContextSequence(observer, {
      transcriptMessageId: "assistant-1",
    });

    await deliverWith({
      replies: [{ text: "original" }],
      runtime,
      bot: createBot({ sendMessage }),
      promptContextSequence,
    });
    await promptContextSequence.finish();

    expect(firstSendText(sendMessage)).toBe("rewritten");
    expect(observer).toHaveBeenCalledWith({ messageId: 304, text: "rewritten" });
  });

  it("records only concrete text chunks that Telegram accepted", async () => {
    const runtime = createRuntime();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 301, chat: { id: "123" } })
      .mockRejectedValueOnce(new Error("second chunk failed"));
    const observer = vi.fn();
    const promptContextSequence = createObservedPromptContextSequence(observer);

    await expect(
      deliverWith({
        replies: [{ text: "chunk-one\n\nchunk-two" }],
        runtime,
        bot: createBot({ sendMessage }),
        textLimit: 12,
        promptContextSequence,
      }),
    ).rejects.toThrow("second chunk failed");
    await promptContextSequence.fail();

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({ messageId: 301, text: "chunk-one\n" });
  });

  it("records the concrete Telegram media message", async () => {
    const runtime = createRuntime();
    const message = {
      message_id: 302,
      date: 1_779_425_460,
      chat: { id: "123", type: "private" },
      photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 10, height: 10 }],
    };
    const sendPhoto = vi.fn().mockResolvedValue(message);
    const observer = vi.fn();
    const promptContextSequence = createObservedPromptContextSequence(observer);
    mockMediaLoad("photo.jpg", "image/jpeg", "photo");

    await deliverWith({
      replies: [{ text: "caption", mediaUrl: "https://example.com/photo.jpg" }],
      runtime,
      bot: createBot({ sendPhoto }),
      promptContextSequence,
    });
    await promptContextSequence.finish();

    expect(observer).toHaveBeenCalledWith({ messageId: 302, message, text: "caption" });
  });

  it("records voice fallback text after the fallback send succeeds", async () => {
    const { runtime, bot } = createVoiceFailureHarness({
      voiceError: createVoiceMessagesForbiddenError(),
      sendMessageResult: { message_id: 303, chat: { id: "123" } },
    });
    const observer = vi.fn();
    const promptContextSequence = createObservedPromptContextSequence(observer);
    mockMediaLoad("note.ogg", "audio/ogg", "voice");

    await deliverWith({
      replies: [
        {
          mediaUrl: "https://example.com/note.ogg",
          audioAsVoice: true,
          spokenText: "Voice fallback",
        },
      ],
      runtime,
      bot,
      promptContextSequence,
    });
    await promptContextSequence.finish();

    expect(observer).toHaveBeenCalledWith({ messageId: 303, text: "Voice fallback" });
  });
});
