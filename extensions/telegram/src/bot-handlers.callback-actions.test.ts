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
  const api: Record<string, unknown> = { editMessageText };
  if (params.rawEditMessageText) {
    api.raw = { editMessageText: params.rawEditMessageText };
  }
  return { bot: { api } as never, api, editMessageText };
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

  it("falls back to the legacy edit when the rich edit fails for a non-terminal reason", async () => {
    const rawEditMessageText = vi.fn(async () => {
      throw new Error("400: Bad Request: some other failure");
    });
    const { bot, editMessageText } = buildBot({ rawEditMessageText });
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("hello", undefined, helloBlocksOverride);

    expect(rawEditMessageText).toHaveBeenCalledOnce();
    expect(editMessageText).toHaveBeenCalledWith(111, 222, "hello", undefined);
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

  it("falls back to the legacy edit when the rich raw API is unavailable", async () => {
    const { bot, editMessageText } = buildBot();
    const actions = createTelegramCallbackMessageActions({
      bot,
      callbackMessage,
      isForum: false,
      richMessages: true,
    });

    await actions.editCallbackMessage("hello", undefined, helloBlocksOverride);

    expect(editMessageText).toHaveBeenCalledWith(111, 222, "hello", undefined);
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
