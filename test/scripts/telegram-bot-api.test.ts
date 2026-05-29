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
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
      }),
    );

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

  it("bounds oversized Bot API response bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: {}, padding: "x".repeat(128) }), {
        status: 200,
      }),
    );

    await expect(
      telegramBotApi(
        "test-token",
        "getMe",
        {},
        {
          baseUrl: "https://telegram.test",
          fetchImpl,
          maxBodyBytes: 16,
        },
      ),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "Telegram Bot API getMe response body exceeded 16 bytes",
    });
  });
});
