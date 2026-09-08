import { describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
  makeTelegramApiTestMock,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi, loadConfig, loadWebMedia } = getTelegramSendTestMocks();
const { editMessageTelegram, sendMessageTelegram } = await importTelegramSendModule();
const { telegramCaptionDeliveryMetadata } = await import("./caption.js");

describe("Telegram caption edits", () => {
  it.each([
    {
      description: "non-empty plain",
      caption: "Updated **caption**",
      expected: "Updated <b>caption</b>",
      richMessages: false,
    },
    { description: "empty plain", caption: "", expected: "", richMessages: false },
    {
      description: "non-empty rich",
      caption: "Updated **caption**",
      expected: "Updated <b>caption</b>",
      richMessages: true,
    },
    { description: "empty rich", caption: "", expected: "", richMessages: true },
  ])(
    "preserves $description captions at the Bot API boundary",
    async ({ caption, expected, richMessages }) => {
      loadConfig.mockReturnValue({ channels: { telegram: { botToken: "tok", richMessages } } });
      botApi.editMessageCaption.mockResolvedValue({ message_id: 321, chat: { id: "123456" } });

      await editMessageTelegram("123456", 321, caption, {
        cfg: { channels: { telegram: { botToken: "tok", richMessages } } },
        token: "tok",
        accountId: "default",
        editMode: "caption",
      });

      expect(botApi.editMessageText).not.toHaveBeenCalled();
      expect(botApi.editMessageCaption).toHaveBeenCalledWith("123456", 321, {
        caption: expected,
        parse_mode: "HTML",
      });
    },
  );
});

describe("Telegram caption delivery facts", () => {
  it.each([
    { kind: "photo", contentType: "image/jpeg", fileName: "photo.jpg" },
    { kind: "document", contentType: "application/pdf", fileName: "document.pdf" },
    { kind: "video", contentType: "video/mp4", fileName: "video.mp4" },
  ])("preserves accepted $kind caption and keyboard facts in its result", async (media) => {
    const sendMedia = vi.fn().mockResolvedValue({ message_id: 70, chat: { id: "123" } });
    const api = makeTelegramApiTestMock({
      sendPhoto: sendMedia,
      sendDocument: sendMedia,
      sendVideo: sendMedia,
    });
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("media"),
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const onDeliveryResult = vi.fn((delivery: { meta?: object }) => {
      expect(delivery.meta && telegramCaptionDeliveryMetadata.has(delivery.meta)).toBe(true);
    });

    const result = await sendMessageTelegram("123", "Choose **one**", {
      cfg: {},
      token: "42:test-token",
      api,
      mediaUrl: `https://example.com/${media.fileName}`,
      buttons: [[{ text: "Choose", callback_data: "choice" }]],
      onDeliveryResult,
    });

    expect(sendMedia).toHaveBeenCalledOnce();
    expect(result.meta).toEqual({
      telegramDeliveredText: "Choose **one**",
      telegramHasInlineKeyboard: true,
    });
    expect(result.meta).toBe(onDeliveryResult.mock.calls[0]?.[0]?.meta);
    expect(Object.keys(result.meta ?? {})).toEqual([
      "telegramDeliveredText",
      "telegramHasInlineKeyboard",
    ]);
  });

  it("retains the accepted caption identity when inline controls are retrofitted", async () => {
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 70, chat: { id: "123" } });
    const sendMessage = vi.fn().mockRejectedValue(new Error("Bad Request: text must be non-empty"));
    const editMessageReplyMarkup = vi.fn().mockResolvedValue({ message_id: 70 });
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("photo"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });
    const onDeliveryResult = vi.fn();

    const result = await sendMessageTelegram("123", "\u200B".repeat(1025), {
      cfg: {},
      token: "42:test-token",
      api: makeTelegramApiTestMock({ sendPhoto, sendMessage, editMessageReplyMarkup }),
      textMode: "html",
      mediaUrl: "https://example.com/photo.jpg",
      buttons: [[{ text: "Choose", callback_data: "choice" }]],
      onDeliveryResult,
    });

    expect(result.meta).toEqual({ telegramHasInlineKeyboard: true });
    expect(result.meta && telegramCaptionDeliveryMetadata.has(result.meta)).toBe(true);
    expect(onDeliveryResult.mock.calls[0]?.[0]?.meta).toEqual({
      telegramHasInlineKeyboard: false,
    });
    expect(editMessageReplyMarkup).toHaveBeenCalledOnce();
  });
});
