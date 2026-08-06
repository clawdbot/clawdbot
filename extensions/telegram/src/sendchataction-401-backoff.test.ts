// Telegram tests cover sendchataction 401 and transient backoff plugin behavior.
import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn().mockResolvedValue(undefined),
}));

// Mock the runtime-exported backoff sleep that the handler actually imports.
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  computeBackoff: vi.fn((_policy, attempt: number) => attempt * 1000),
  sleepWithAbort: mocks.sleepWithAbort,
}));

let createTelegramSendChatActionHandler: typeof import("./sendchataction-401-backoff.js").createTelegramSendChatActionHandler;

describe("createTelegramSendChatActionHandler", () => {
  beforeAll(async () => {
    ({ createTelegramSendChatActionHandler } = await import("./sendchataction-401-backoff.js"));
  });

  const make401Error = () => new Error("401 Unauthorized");
  const make500Error = () => new Error("500 Internal Server Error");
  const makeNetworkError = () =>
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const makeTelegramError = (
    message: string,
    error_code: number,
    parameters?: { retry_after?: number },
  ) => Object.assign(new Error(message), { error_code, parameters });

  it("calls sendChatActionFn on success", async () => {
    const fn = vi.fn().mockResolvedValue(true);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
    });

    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledWith(123, "typing", undefined);
    expect(handler.isSuspended()).toBe(false);
  });

  it("coalesces duplicate chat actions while one for the chat is pending", async () => {
    let resolveSend: ((value: true) => void) | undefined;
    const send = new Promise<true>((resolve) => {
      resolveSend = resolve;
    });
    const fn = vi.fn(() => send);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      minIntervalMs: 4000,
    });

    const first = handler.sendChatAction(-100, "typing", { message_thread_id: 1 });
    await handler.sendChatAction(-100, "typing", { message_thread_id: 2 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(-100, "typing", { message_thread_id: 1 });

    resolveSend?.(true);
    await first;
  });

  it("coalesces recent same-chat actions after the pending send resolves", async () => {
    let now = 1000;
    const fn = vi.fn().mockResolvedValue(true);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      minIntervalMs: 4000,
      now: () => now,
    });

    await handler.sendChatAction(-100, "typing");
    now = 4999;
    await handler.sendChatAction(-100, "typing");
    expect(fn).toHaveBeenCalledTimes(1);

    await handler.sendChatAction(-100, "upload_photo");
    expect(fn).toHaveBeenCalledTimes(2);

    now = 5000;
    await handler.sendChatAction(-100, "typing");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("applies exponential backoff on consecutive 401 errors", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5,
    });

    // First call fails with 401
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(false);

    // Second call should mention backoff in logs
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(logger.mock.calls).toEqual([
      ["sendChatAction 401 error (1/5). Retrying with exponential backoff."],
      ["sendChatAction backoff: waiting 1000ms before retry (failure 1/5)"],
      ["sendChatAction 401 error (2/5). Retrying with exponential backoff."],
    ]);
  });

  it("suspends after maxConsecutive401 failures", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");

    expect(handler.isSuspended()).toBe(true);
    expect(logger.mock.calls.at(-1)).toEqual([
      "CRITICAL: sendChatAction suspended after 3 consecutive 401 errors. Bot token is likely invalid. Telegram may DELETE the bot if requests continue. Replace the Telegram token in config/env, then restart the Gateway.",
    ]);

    // Subsequent calls are silently skipped
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(3); // not called again
  });

  it("resets failure counter on success", async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        throw make401Error();
      }
      return Promise.resolve(true);
    });
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 5,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    // Third call succeeds
    await handler.sendChatAction(123, "typing");

    expect(handler.isSuspended()).toBe(false);
    expect(logger.mock.calls.at(-1)).toEqual([
      "sendChatAction recovered after 2 consecutive 401 failures",
    ]);
  });

  it("does not count non-401 errors toward suspension", async () => {
    const fn = vi.fn().mockRejectedValue(make500Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 2,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("500");

    expect(handler.isSuspended()).toBe(false);
  });

  it.each([
    ["recoverable network", () => makeNetworkError(), 1000],
    ["snippet-only network", () => new Error("socket hang up"), 1000],
    ["Telegram 429", () => makeTelegramError("Too Many Requests", 429, { retry_after: 2 }), 2000],
    ["Telegram 5xx", () => makeTelegramError("Bad Gateway", 502), 1000],
  ])("cools down transient %s errors", async (_name, makeError, expectedCooldownMs) => {
    let now = 10_000;
    const fn = vi.fn().mockRejectedValueOnce(makeError()).mockResolvedValue(true);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      now: () => now,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow();
    expect(logger.mock.calls.at(-1)).toEqual([
      `sendChatAction transient error (1). Cooling down ${expectedCooldownMs}ms before retry.`,
    ]);

    now += expectedCooldownMs - 1;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow(
      "transient cooldown active",
    );
    expect(fn).toHaveBeenCalledTimes(1);

    now += 1;
    await handler.sendChatAction(123, "typing");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rejects transient keepalive ticks until same-chat coalescing expires", async () => {
    let now = 0;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeTelegramError("Bad Gateway", 502))
      .mockResolvedValue(true);
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      minIntervalMs: 4000,
      now: () => now,
    });

    await expect(handler.sendChatAction(-100, "typing")).rejects.toThrow("Bad Gateway");
    expect(logger.mock.calls.at(-1)).toEqual([
      "sendChatAction transient error (1). Cooling down 4000ms before retry.",
    ]);

    now = 3000;
    await expect(handler.sendChatAction(-100, "typing")).rejects.toThrow(
      "transient cooldown active",
    );
    expect(fn).toHaveBeenCalledTimes(1);

    now = 4000;
    await handler.sendChatAction(-100, "typing");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("resets transient counters on non-transient errors", async () => {
    let now = 1000;
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeTelegramError("Bad Gateway", 502))
      .mockRejectedValueOnce(new Error("400 Bad Request"))
      .mockRejectedValueOnce(makeTelegramError("Bad Gateway", 502));
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      now: () => now,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("Bad Gateway");
    now = 2000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("400 Bad Request");
    now = 3000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("Bad Gateway");

    expect(
      logger.mock.calls.filter(([message]) =>
        String(message).startsWith("sendChatAction transient error"),
      ),
    ).toEqual([
      ["sendChatAction transient error (1). Cooling down 1000ms before retry."],
      ["sendChatAction transient error (1). Cooling down 1000ms before retry."],
    ]);
  });

  it("reset() clears suspension", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 1,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(true);

    handler.reset();
    expect(handler.isSuspended()).toBe(false);
  });

  it("is shared across multiple chatIds (global handler)", async () => {
    const fn = vi.fn().mockRejectedValue(make401Error());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    // Different chatIds all contribute to the same failure counter
    await expect(handler.sendChatAction(111, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(222, "typing")).rejects.toThrow("401");
    await expect(handler.sendChatAction(333, "typing")).rejects.toThrow("401");

    expect(handler.isSuspended()).toBe(true);
    // Suspended for all chats
    await handler.sendChatAction(444, "typing");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("treats a structured 429 with retry_after=401 as transient, not as a 401 suspension", async () => {
    // grammY renders this as: "Call to 'sendChatAction' failed! (429: Too Many Requests: retry after 401)"
    // The substring "401" in the message must NOT trigger the 401 suspension path.
    const make429WithRetryAfter401 = () =>
      Object.assign(
        new Error("Call to 'sendChatAction' failed! (429: Too Many Requests: retry after 401)"),
        { error_code: 429, parameters: { retry_after: 401 } },
      );

    let now = 0;
    const fn = vi.fn().mockRejectedValue(make429WithRetryAfter401());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
      now: () => now,
    });

    // All calls should fail but as transient errors, NOT 401 errors
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("429");
    // Advance past the transient cooldown (retry_after=401 → 401000ms)
    now += 402_000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("429");
    now += 402_000;
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("429");

    // Handler must NOT be suspended — this is a transient 429, not a 401
    expect(handler.isSuspended()).toBe(false);

    // Must NOT have logged the CRITICAL token-deletion alarm
    const criticalLogs = logger.mock.calls.filter(([msg]) => String(msg).includes("CRITICAL"));
    expect(criticalLogs).toEqual([]);
  });

  it("detects a structured Telegram 401 error by error_code, not by message substring", async () => {
    const makeStructured401 = () => Object.assign(new Error("Unauthorized"), { error_code: 401 });

    const fn = vi.fn().mockRejectedValue(makeStructured401());
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 2,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("Unauthorized");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("Unauthorized");

    expect(handler.isSuspended()).toBe(true);
    expect(logger.mock.calls.at(-1)).toEqual([
      "CRITICAL: sendChatAction suspended after 2 consecutive 401 errors. Bot token is likely invalid. Telegram may DELETE the bot if requests continue. Replace the Telegram token in config/env, then restart the Gateway.",
    ]);
  });

  it("does not misclassify a plain error whose message contains '401' as a 401 error", async () => {
    // A plain Error (no error_code) with "401" in its message should NOT
    // trigger the 401 path, since bare substring matching was the root cause
    // of #94787. Only "unauthorized" is the fallback for non-Telegram errors.
    const fn = vi.fn().mockRejectedValue(new Error("401 Too Many Requests: retry after"));
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 3,
    });

    // This is neither a recognized 401 nor a recognized transient → falls to
    // the "else" branch (clears transient cooldown, re-throws).
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("401");
    expect(handler.isSuspended()).toBe(false);
  });

  it("recognizes non-Telegram 401 via 'unauthorized' in message as a 401", async () => {
    // A plain Error without error_code but with "unauthorized" should still
    // be classified as 401 (this is the intentional fallback path).
    const fn = vi.fn().mockRejectedValue(new Error("Unauthorized access"));
    const logger = vi.fn();
    const handler = createTelegramSendChatActionHandler({
      sendChatActionFn: fn,
      logger,
      maxConsecutive401: 2,
    });

    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("Unauthorized");
    await expect(handler.sendChatAction(123, "typing")).rejects.toThrow("Unauthorized");

    expect(handler.isSuspended()).toBe(true);
  });
});
