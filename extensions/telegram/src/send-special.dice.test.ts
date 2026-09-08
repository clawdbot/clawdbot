// Telegram tests cover sendDice outbound behavior.
import { describe, expect, it, vi } from "vitest";
import { sendDiceTelegram } from "./send-special.js";
import { makeTelegramApiTestMock } from "./send.test-harness.js";

const TEST_CFG = { session: { store: ":memory:" } } as never;

describe("sendDiceTelegram", () => {
  it("defaults to 🎲 and returns the server-rolled value", async () => {
    const chatId = "123";
    const sendDice = vi.fn().mockResolvedValue({
      message_id: 200,
      chat: { id: chatId },
      dice: { emoji: "🎲", value: 4 },
    });

    const res = await sendDiceTelegram(chatId, undefined, {
      cfg: TEST_CFG,
      token: "tok",
      api: makeTelegramApiTestMock({ sendDice }),
    });

    expect(sendDice).toHaveBeenCalledWith(chatId, "🎲", undefined);
    expect(res.messageId).toBe("200");
    expect(res.chatId).toBe(chatId);
    expect(res.emoji).toBe("🎲");
    expect(res.value).toBe(4);
  });

  it.each(["🎲", "🎯", "🏀", "⚽", "🎳", "🎰"])("passes the %s face through", async (emoji) => {
    const sendDice = vi.fn().mockResolvedValue({
      message_id: 201,
      chat: { id: "123" },
      dice: { emoji, value: 6 },
    });

    const res = await sendDiceTelegram("123", emoji, {
      cfg: TEST_CFG,
      token: "tok",
      api: makeTelegramApiTestMock({ sendDice }),
    });

    expect(sendDice).toHaveBeenCalledWith("123", emoji, undefined);
    expect(res.emoji).toBe(emoji);
    expect(res.value).toBe(6);
  });

  it("accepts a face carrying the emoji presentation selector", async () => {
    const sendDice = vi.fn().mockResolvedValue({
      message_id: 203,
      chat: { id: "123" },
      dice: { emoji: "⚽", value: 3 },
    });

    await sendDiceTelegram("123", "⚽\uFE0F", {
      cfg: TEST_CFG,
      token: "tok",
      api: makeTelegramApiTestMock({ sendDice }),
    });

    expect(sendDice).toHaveBeenCalledWith("123", "⚽", undefined);
  });

  it("rejects an unsupported emoji before calling the API", async () => {
    const sendDice = vi.fn();
    await expect(
      sendDiceTelegram("123", "🎈", {
        cfg: TEST_CFG,
        token: "tok",
        api: makeTelegramApiTestMock({ sendDice }),
      }),
    ).rejects.toThrow(/Unsupported Telegram dice emoji/u);
    expect(sendDice).not.toHaveBeenCalled();
  });

  it("omits the value when Telegram returns no dice payload", async () => {
    const sendDice = vi.fn().mockResolvedValue({ message_id: 202, chat: { id: "123" } });

    const res = await sendDiceTelegram("123", "🎲", {
      cfg: TEST_CFG,
      token: "tok",
      api: makeTelegramApiTestMock({ sendDice }),
    });

    expect(res.value).toBeUndefined();
  });
});
