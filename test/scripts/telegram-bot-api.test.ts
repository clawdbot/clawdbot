import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramBotApi } from "../../scripts/e2e/telegram-bot-api.ts";

describe("Telegram Bot API helper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns successful Bot API results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { username: "OpenClawBot" } }), {
        status: 200,
      }),
    );

    await expect(
      telegramBotApi("test-token", "getMe", {}, { baseUrl: "https://telegram.test", fetchImpl }),
    ).resolves.toEqual({ username: "OpenClawBot" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://telegram.test/bottest-token/getMe",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
  });

  it("surfaces Telegram API descriptions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
        status: 400,
      }),
    );

    await expect(
      telegramBotApi(
        "test-token",
        "sendMessage",
        {},
        { baseUrl: "https://telegram.test", fetchImpl },
      ),
    ).rejects.toThrow("chat not found");
  });

  it("bounds stalled Bot API response bodies", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    });

    const result = telegramBotApi(
      "test-token",
      "getUpdates",
      {},
      {
        baseUrl: "https://telegram.test",
        fetchImpl,
        timeoutMs: 100,
      },
    );
    const rejection = expect(result).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "Telegram Bot API getUpdates timed out after 100ms",
    });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });
});
