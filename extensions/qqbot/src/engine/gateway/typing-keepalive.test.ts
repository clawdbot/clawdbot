import { afterEach, describe, expect, it, vi } from "vitest";
import { TypingKeepAlive, TYPING_INPUT_SECOND, TYPING_RENEWAL_LIMIT } from "./typing-keepalive.js";

describe("TypingKeepAlive", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renews C2C typing every 5 seconds with a 10 second input window", async () => {
    vi.useFakeTimers();
    const sendInputNotify = vi.fn(async () => undefined);
    const keepAlive = new TypingKeepAlive(
      async () => "token-1",
      vi.fn(),
      sendInputNotify,
      "openid-1",
      "msg-1",
    );

    keepAlive.start();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(sendInputNotify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendInputNotify).toHaveBeenCalledTimes(1);
    expect(sendInputNotify).toHaveBeenLastCalledWith("token-1", "openid-1", "msg-1", 10);
    expect(TYPING_INPUT_SECOND).toBe(10);

    keepAlive.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(1);
  });

  it("caps renewals so long C2C replies keep a final passive reply slot", async () => {
    vi.useFakeTimers();
    const sendInputNotify = vi.fn(async () => undefined);
    const keepAlive = new TypingKeepAlive(
      async () => "token-1",
      vi.fn(),
      sendInputNotify,
      "openid-1",
      "msg-1",
    );

    keepAlive.start();

    await vi.advanceTimersByTimeAsync(5_000 * TYPING_RENEWAL_LIMIT);
    expect(TYPING_RENEWAL_LIMIT).toBe(3);
    expect(sendInputNotify).toHaveBeenCalledTimes(TYPING_RENEWAL_LIMIT);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(TYPING_RENEWAL_LIMIT);
  });
});
