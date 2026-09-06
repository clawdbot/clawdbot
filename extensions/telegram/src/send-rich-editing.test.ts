import { describe, expect, it } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi, botRawApi } = getTelegramSendTestMocks();
const { editMessageTelegram } = await importTelegramSendModule();
const richConfig = { channels: { telegram: { richMessages: true } } };
const editedMessage = { message_id: 321, chat: { id: 123, type: "private" } };
const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, index) => `P${String(index + 1).padStart(3, "0")}`);
const listItems = (count: number) =>
  Array.from({ length: count }, (_, index) => `L${String(index + 1).padStart(3, "0")}`);

describe("Telegram rich message edits", () => {
  it.each([false, true])(
    "retains styled HTML links on edits (plain recovery: %s)",
    async (plain) => {
      const text =
        '<details><summary>More</summary><p><a href="https://example.com">**Download**</a></p></details>';
      if (plain) {
        botRawApi.editMessageText.mockRejectedValueOnce(
          new Error("400: Bad Request: RICH_MESSAGE_URL_INVALID"),
        );
        botApi.editMessageText.mockResolvedValueOnce(editedMessage);
      } else {
        botRawApi.editMessageText.mockResolvedValueOnce(editedMessage);
      }

      await editMessageTelegram("123", 321, text, { cfg: richConfig, token: "tok" });

      const richMessage = botRawApi.editMessageText.mock.calls[0]?.[0].rich_message;
      expect(JSON.stringify(richMessage)).toContain('"type":"url"');
      expect(JSON.stringify(richMessage)).toContain('"url":"https://example.com"');
      if (plain) {
        expect(botApi.editMessageText.mock.calls[0]?.[2]).toBe("More\nDownload");
      } else {
        expect(botApi.editMessageText).not.toHaveBeenCalled();
      }
    },
  );

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

  it("keeps source text visible when rich rendering produces no blocks", async () => {
    const text = "[reference]: https://example.com";
    botApi.editMessageText.mockResolvedValueOnce(editedMessage);

    await editMessageTelegram("123", 321, text, { cfg: richConfig, token: "tok" });

    expect(botApi.editMessageText).toHaveBeenCalledWith("123", 321, text);
    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
  });

  it("rejects an oversized plain replacement without editing separate chunks", async () => {
    const text = `START${"x".repeat(4100)}END`;
    botRawApi.editMessageText.mockRejectedValueOnce(
      new Error("400: Bad Request: RICH_MESSAGE_URL_INVALID"),
    );
    const rejection = new Error("400: Bad Request: message is too long");
    botApi.editMessageText.mockRejectedValueOnce(rejection);

    await expect(
      editMessageTelegram("123", 321, text, { cfg: richConfig, token: "tok" }),
    ).rejects.toBe(rejection);

    expect(botApi.editMessageText).toHaveBeenCalledExactlyOnceWith("123", 321, text);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });
});
