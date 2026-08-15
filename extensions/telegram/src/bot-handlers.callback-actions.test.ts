// Telegram callback message action tests: rich/legacy edit routing.
import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createTelegramCallbackMessageActions } from "./bot-handlers.callback-actions.js";

const callbackMessage = {
  chat: { id: 111, type: "private" },
  message_id: 222,
} as unknown as Message;

const helloBlocksOverride = { blocks: [{ type: "paragraph" as const, text: "hello" }] };

// rich-message.ts's TelegramRichRawApi/editMessageText param type isn't exported (it's an
// internal facade shape); mirror its call signature here so vi.fn infers a single-argument
// mock instead of a zero-arg one, which is what makes `.mock.calls[0][0]` type-check.
type RichEditMessageText = (params: Record<string, unknown>) => Promise<Message | true>;

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function buildBot(
  params: { rawEditMessageText?: ReturnType<typeof vi.fn<RichEditMessageText>> } = {},
) {
  const editMessageText = vi.fn(async () => true as const);
  const deleteMessage = vi.fn(async () => true as const);
  const sendMessage = vi.fn(async () => ({ message_id: 333 }) as unknown as Message);
  const api: Record<string, unknown> = { editMessageText, deleteMessage, sendMessage };
  if (params.rawEditMessageText) {
    api.raw = { editMessageText: params.rawEditMessageText };
  }
  return { bot: { api } as never, api, editMessageText, deleteMessage, sendMessage };
}

describe("createTelegramCallbackMessageActions editCallbackMessage", () => {
  it("uses the legacy edit funnel when richMessages is not enabled", async () => {
    const { bot, editMessageText } = buildBot();
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
    });

    await actions.editCallbackMessage("hello");

    expect(editMessageText).toHaveBeenCalledWith(111, 222, "hello", undefined);
  });

  it("keeps plain-text edits with no richTextOverride on the legacy funnel even when richMessages is enabled", async () => {
    // Regression for #123886's follow-up finding: richMessages must not make
    // editCallbackMessage auto-markdown-parse arbitrary un-authored text (approval
    // receipts, plugin respond.editMessage, the model picker's own intermediate
    // pagination/list/error edits). Only an explicit richTextOverride opts into rich
    // routing; everything else keeps sending its text unparsed, exactly like richMessages
    // never existed.
    const rawEditMessageText = vi.fn(async () => true as const);
    const { bot, editMessageText } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("**hello**");

    expect(editMessageText).toHaveBeenCalledWith(111, 222, "**hello**", undefined);
    expect(rawEditMessageText).not.toHaveBeenCalled();
  });

  it("keeps parse_mode HTML edits on the legacy funnel even when richMessages is enabled", async () => {
    const rawEditMessageText = vi.fn(async () => true as const);
    const { bot, editMessageText } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("<b>hello</b>", { parse_mode: "HTML" });

    expect(editMessageText).toHaveBeenCalledWith(111, 222, "<b>hello</b>", { parse_mode: "HTML" });
    expect(rawEditMessageText).not.toHaveBeenCalled();
  });

  it("deletes and replies instead of legacy-editing when the rich edit fails for a non-terminal reason", async () => {
    // Regression for ClawSweeper's follow-up P2 finding: richTextOverride is only ever
    // supplied for a message that was itself sent as rich (the /model picker's
    // confirmation), so a legacy-text retry on raw-edit failure would reproduce the exact
    // stale-rich-markup symptom #123886 reported. Delete-and-reply must be used instead.
    const rawEditMessageText = vi.fn(async () => {
      throw new Error("400: Bad Request: some other failure");
    });
    const { bot, editMessageText, deleteMessage, sendMessage } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("hello", undefined, helloBlocksOverride);

    expect(rawEditMessageText).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith(111, 222);
    expect(sendMessage).toHaveBeenCalledWith(111, "hello", {});
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("re-raises 'message is not modified' from a rich edit without a legacy retry", async () => {
    const rawEditMessageText = vi.fn(async () => {
      throw new Error("400: Bad Request: message is not modified");
    });
    const { bot, editMessageText } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await expect(
      actions.editCallbackMessage("hello", undefined, helloBlocksOverride),
    ).rejects.toThrow("message is not modified");
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("deletes and replies instead of legacy-editing when the rich raw API is unavailable", async () => {
    const { bot, editMessageText, deleteMessage, sendMessage } = buildBot();
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("hello", undefined, helloBlocksOverride);

    expect(deleteMessage).toHaveBeenCalledWith(111, 222);
    expect(sendMessage).toHaveBeenCalledWith(111, "hello", {});
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("routes a parse_mode HTML edit through the rich raw API when richTextOverride is supplied", async () => {
    // Regression for #123886: a caller editing a message that was itself
    // sent as rich (e.g. the /model picker's final confirmation) must opt
    // back onto the rich funnel even though it authors HTML, since a
    // legacy-text edit there leaves the prior rich body's markup visible
    // underneath the new plain text instead of replacing it.
    const rawEditMessageText = vi.fn<RichEditMessageText>(async () => true as const);
    const { bot, editMessageText } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage(
      "<b>hello</b>",
      { parse_mode: "HTML" },
      { blocks: [{ type: "paragraph", text: "hello" }] },
    );

    expect(rawEditMessageText).toHaveBeenCalledOnce();
    expect(
      requireValue(rawEditMessageText.mock.calls.at(0), "rawEditMessageText call")[0],
    ).toMatchObject({
      chat_id: 111,
      message_id: 222,
      rich_message: { blocks: [{ type: "paragraph", text: "hello" }] },
    });
    expect(editMessageText).not.toHaveBeenCalled();
  });
});

describe("createTelegramCallbackMessageActions editCallbackMessageWithButtons", () => {
  it("deletes and replies, through the real /model-picker-confirmation call shape, when the rich edit fails", async () => {
    // editCallbackMessageWithButtons is what bot-handlers.model-callback.ts's final
    // confirmation actually calls (with richTextOverride, parse_mode: "HTML", and an empty
    // buttons array). Its own catch block must not re-introduce a legacy-edit fallback for
    // that path once editCallbackMessage's inner catch stops doing so.
    const rawEditMessageText = vi.fn(async () => {
      throw new Error("400: Bad Request: some other failure");
    });
    const { bot, editMessageText, deleteMessage, sendMessage } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessageWithButtons(
      "hello",
      [],
      { parse_mode: "HTML" },
      helloBlocksOverride,
    );

    expect(rawEditMessageText).toHaveBeenCalledOnce();
    expect(deleteMessage).toHaveBeenCalledWith(111, 222);
    expect(sendMessage).toHaveBeenCalledWith(111, "hello", { parse_mode: "HTML" });
    expect(editMessageText).not.toHaveBeenCalled();
  });
});
