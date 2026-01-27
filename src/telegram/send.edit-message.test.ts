import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    editMessageText: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    constructor(public token: string) {
      botCtorSpy(token);
    }
  },
  InputFile: class {},
}));

import { editMessageTelegram } from "./send.js";

describe("editMessageTelegram", () => {
  beforeEach(() => {
    botApi.editMessageText.mockReset();
    botCtorSpy.mockReset();
  });

  it("keeps existing buttons when buttons is undefined (no reply_markup)", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "hi", {
      token: "tok",
      cfg: {},
    });

    expect(botCtorSpy).toHaveBeenCalledWith("tok");
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const call = botApi.editMessageText.mock.calls[0] ?? [];
    const params = call[3] as Record<string, unknown>;
    expect(params).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(params).not.toHaveProperty("reply_markup");
  });

  it("removes buttons when buttons is empty (reply_markup.inline_keyboard = [])", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "hi", {
      token: "tok",
      cfg: {},
      buttons: [],
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const params = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(params).toEqual(
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }),
    );
  });

  it("falls back to plain text when Telegram HTML parse fails (and preserves reply_markup)", async () => {
    botApi.editMessageText
      .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "<bad> html", {
      token: "tok",
      cfg: {},
      buttons: [],
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(2);

    const firstParams = (botApi.editMessageText.mock.calls[0] ?? [])[3] as Record<string, unknown>;
    expect(firstParams).toEqual(
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      }),
    );

    const secondParams = (botApi.editMessageText.mock.calls[1] ?? [])[3] as Record<string, unknown>;
    expect(secondParams).toEqual(
      expect.objectContaining({
        reply_markup: { inline_keyboard: [] },
      }),
    );
  });
});
