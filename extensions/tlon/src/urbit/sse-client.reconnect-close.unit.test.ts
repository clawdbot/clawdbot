import { afterEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UrbitSSEClient owned reconnect timers", () => {
  it.each([
    { name: "ordinary reconnect", exhausted: false, delayMs: 1_000 },
    { name: "exhausted ten-second cooldown", exhausted: true, delayMs: 10_000 },
  ])("clears the $name timer immediately when the monitor stops receiving", async (params) => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const onReconnect = vi.fn();
    const logger = { log: vi.fn() };
    const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=synthetic", {
      maxReconnectAttempts: 1,
      reconnectDelay: 1_000,
      onReconnect,
      logger,
    });
    if (params.exhausted) {
      client.reconnectAttempts = client.maxReconnectAttempts;
    }

    const reconnect = client.attemptReconnect();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), params.delayMs);
    expect(vi.getTimerCount()).toBe(1);
    client.stopReceiving();

    await expect(reconnect).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(onReconnect).not.toHaveBeenCalled();
    if (params.exhausted) {
      expect(logger.log).not.toHaveBeenCalledWith(
        expect.stringContaining("reset, resuming reconnection"),
      );
    }
  });
});
