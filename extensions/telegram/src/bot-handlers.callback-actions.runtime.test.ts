// Callback-edit action tests cover rich-vs-legacy message edit routing.
import { describe, expect, it, vi } from "vitest";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.runtime.js";

function buildTestBot(apiOverrides: Record<string, unknown> = {}) {
  const editMessageText = vi.fn(async () => true);
  const richEditMessageText = vi.fn(async () => true);
  const bot = {
    api: {
      editMessageText,
      editMessageReplyMarkup: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
      sendMessage: vi.fn(async () => true),
      ...apiOverrides,
      raw: {
        editMessageText: richEditMessageText,
        ...(apiOverrides.raw ?? {}),
      },
    },
  } as never;
  return { bot, editMessageText, richEditMessageText };
}

const callbackMessage = {
  chat: { id: 123 },
  message_id: 456,
  message_thread_id: undefined,
  direct_messages_topic: undefined,
} as never;

describe("createTelegramCallbackMessageActions", () => {
  it("edits through the rich raw API when rich messages are enabled", async () => {
    const { bot, editMessageText, richEditMessageText } = buildTestBot();
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: false,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("Select a model:", {
      reply_markup: { inline_keyboard: [] },
    });

    expect(richEditMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).not.toHaveBeenCalled();
    const params = richEditMessageText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.chat_id).toBe(123);
    expect(params.message_id).toBe(456);
    expect(params.rich_message).toBeDefined();
    expect(params.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("keeps legacy text edits when rich messages are disabled", async () => {
    const { bot, editMessageText, richEditMessageText } = buildTestBot();
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: false,
      isForum: false,
      richMessages: false,
    });

    await actions.editCallbackMessage("Select a model:");

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(richEditMessageText).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith(123, 456, "Select a model:", undefined);
  });

  it("keeps caller-authored HTML edits on the legacy parse_mode HTML path", async () => {
    const { bot, editMessageText, richEditMessageText } = buildTestBot();
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: false,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("✅ Model changed to <b>zai/model</b>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });

    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(richEditMessageText).not.toHaveBeenCalled();
    expect(editMessageText).toHaveBeenCalledWith(123, 456, "✅ Model changed to <b>zai/model</b>", {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("falls back to the legacy text edit when the rich edit fails", async () => {
    const { bot, editMessageText, richEditMessageText } = buildTestBot();
    richEditMessageText.mockRejectedValueOnce(new Error("Bad Request: rich payload rejected"));
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: false,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("Select a model:");

    expect(richEditMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText).toHaveBeenCalledWith(123, 456, "Select a model:", undefined);
  });

  it("re-raises message-is-not-modified from the rich edit without a legacy retry", async () => {
    const { bot, editMessageText, richEditMessageText } = buildTestBot();
    richEditMessageText.mockRejectedValueOnce(
      Object.assign(new Error("400: Bad Request: message is not modified"), {
        error_code: 400,
      }),
    );
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: false,
      isForum: false,
      richMessages: true,
    });

    await expect(actions.editCallbackMessage("Select a model:")).rejects.toThrow(
      "message is not modified",
    );
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("falls back to legacy edits when the raw rich API is unavailable", async () => {
    const { bot, editMessageText } = buildTestBot();
    (bot.api as { raw?: unknown }).raw = undefined;
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isGroup: false,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("Select a model:");

    expect(editMessageText).toHaveBeenCalledTimes(1);
  });
});
