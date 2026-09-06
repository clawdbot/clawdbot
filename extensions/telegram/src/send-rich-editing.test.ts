import { describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi, botRawApi } = getTelegramSendTestMocks();
const { editMessageTelegram } = await importTelegramSendModule();
const { sendLogger } = await import("./send-context.js");
const richConfig = { channels: { telegram: { richMessages: true } } };
const editedMessage = { message_id: 321, chat: { id: 123, type: "private" } };
const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, index) => `P${String(index + 1).padStart(3, "0")}`);
const listItems = (count: number) =>
  Array.from({ length: count }, (_, index) => `L${String(index + 1).padStart(3, "0")}`);
const mediaMarkdown = (count: number) =>
  Array.from(
    { length: count },
    (_, index) =>
      `<figure><img src="https://example.com/${index + 1}.jpg"/><figcaption>photo-${index + 1}</figcaption></figure>`,
  ).join("\n\n");

describe("Telegram rich message edits", () => {
  it.each([
    { name: "501 paragraphs", tokens: paragraphs(501), separator: "\n\n", prefix: "" },
    { name: "251 list items", tokens: listItems(251), separator: "\n", prefix: "- " },
  ])("preserves every item when $name requires plain recovery", async (testCase) => {
    const text = testCase.tokens
      .map((token) => `${testCase.prefix}${token}`)
      .join(testCase.separator);
    botRawApi.editMessageText.mockRejectedValueOnce(
      new Error("400: Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY"),
    );
    botApi.editMessageText.mockResolvedValueOnce(editedMessage);

    await expect(
      editMessageTelegram("123", 321, text, {
        cfg: richConfig,
        token: "tok",
        buttons: [],
        linkPreview: false,
      }),
    ).resolves.toEqual({ ok: true, messageId: "321", chatId: "123" });

    expect(botRawApi.editMessageText).toHaveBeenCalledOnce();
    expect(botApi.editMessageText).toHaveBeenCalledOnce();
    const [chatId, messageId, deliveredText, options] = botApi.editMessageText.mock.calls[0]!;
    expect([chatId, messageId]).toEqual(["123", 321]);
    expect(String(deliveredText).match(/[PL]\d{3}/g)).toEqual(testCase.tokens);
    expect(options).toEqual({
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("keeps a complete 500-paragraph replacement on the rich edit endpoint", async () => {
    const tokens = paragraphs(500);
    botRawApi.editMessageText.mockResolvedValueOnce(editedMessage);

    await editMessageTelegram("123", 321, tokens.join("\n\n"), {
      cfg: richConfig,
      token: "tok",
    });

    expect(botRawApi.editMessageText).toHaveBeenCalledOnce();
    expect(JSON.stringify(botRawApi.editMessageText.mock.calls[0]?.[0]).match(/P\d{3}/g)).toEqual(
      tokens,
    );
    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps exactly 20 media on the rich edit endpoint", async () => {
    botRawApi.editMessageText.mockResolvedValueOnce(editedMessage);

    await editMessageTelegram("123", 321, mediaMarkdown(20), {
      cfg: richConfig,
      token: "tok",
    });

    expect(botRawApi.editMessageText).toHaveBeenCalledOnce();
    expect(botApi.editMessageText).not.toHaveBeenCalled();
  });

  it("degrades a 21-media rich edit to one complete visible plain replacement", async () => {
    const warn = vi.spyOn(sendLogger, "warn").mockImplementation(() => {});
    botApi.editMessageText.mockResolvedValueOnce(editedMessage);

    await editMessageTelegram("123", 321, mediaMarkdown(21), {
      cfg: richConfig,
      token: "tok",
    });

    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
    expect(botApi.editMessageText).toHaveBeenCalledOnce();
    const deliveredText = String(botApi.editMessageText.mock.calls[0]?.[2]);
    expect(deliveredText.match(/https:\/\/example\.com\/\d+\.jpg/g)).toHaveLength(21);
    expect(warn).toHaveBeenCalledWith(
      "telegram editMessage degrade=plain-fallback:rich-media-too-many: 21 media exceeds rich edit limit of 20",
    );
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps source text visible when rich rendering produces no blocks", async () => {
    const text = "[reference]: https://example.com";
    botApi.editMessageText.mockResolvedValueOnce(editedMessage);

    await editMessageTelegram("123", 321, text, { cfg: richConfig, token: "tok" });

    expect(botApi.editMessageText).toHaveBeenCalledWith("123", 321, text);
    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
  });

  it("rejects an oversized rich fallback locally without editing separate chunks", async () => {
    const text = `START${"x".repeat(4100)}END`;
    botRawApi.editMessageText.mockRejectedValueOnce(
      new Error("400: Bad Request: RICH_MESSAGE_URL_INVALID"),
    );

    await expect(
      editMessageTelegram("123", 321, text, { cfg: richConfig, token: "tok" }),
    ).rejects.toThrow(
      "telegram editMessage failed: complete plain fallback is 4108 characters, exceeding the 4000-character edit limit",
    );

    expect(botRawApi.editMessageText).toHaveBeenCalledOnce();
    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an oversized 21-media plain projection before any edit request", async () => {
    const text = `${mediaMarkdown(21)}\n\n${"x".repeat(4100)}`;

    await expect(
      editMessageTelegram("123", 321, text, { cfg: richConfig, token: "tok" }),
    ).rejects.toThrow(/complete plain fallback is \d+ characters, exceeding the 4000-character/);

    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });
});
