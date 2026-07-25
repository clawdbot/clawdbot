// Qqbot tests cover typing keepalive plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyLimiter } from "../messaging/reply-limiter.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";

function createTypingClaim(messageId: string) {
  const limiter = new ReplyLimiter({ limit: 5 });
  limiter.record(messageId); // Initial input_notify.
  return (id: string, reserve: number) => limiter.claim(id, reserve);
}

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
      undefined,
      createTypingClaim("msg-1"),
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
      undefined,
      createTypingClaim("msg-1"),
    );

    keepAlive.start();

    await vi.advanceTimersByTimeAsync(5_000 * 3);
    expect(sendInputNotify).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(3);
  });

  it("counts token-refresh retry attempts against the renewal budget", async () => {
    vi.useFakeTimers();
    const clearCache = vi.fn();
    const sendInputNotify = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("11244 token expired"));
    const keepAlive = new TypingKeepAlive(
      async () => "token-1",
      clearCache,
      sendInputNotify,
      "openid-1",
      "msg-1",
      undefined,
      createTypingClaim("msg-1"),
    );

    keepAlive.start();

    // First tick: the failed attempt and its token-refresh retry both claim the shared budget.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(sendInputNotify).toHaveBeenCalledTimes(2);

    // Only one renewal attempt remains before the reserved final-reply slot.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(3);
  });

  it("suppresses overlapping renewals while a send is still in flight", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const sendInputNotify = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const keepAlive = new TypingKeepAlive(
      async () => "token-1",
      vi.fn(),
      sendInputNotify,
      "openid-1",
      "msg-1",
      undefined,
      createTypingClaim("msg-1"),
    );

    keepAlive.start();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(1);

    // A stalled RPC must not double-send or burn extra reply budget.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(1);

    release?.();
    // Let the stalled tick settle so the next interval tick is not suppressed.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendInputNotify).toHaveBeenCalledTimes(2);

    keepAlive.stop();
  });
});
