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
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("backoff"));
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
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));

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
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("recovered"));
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
});
