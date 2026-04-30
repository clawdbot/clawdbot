import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import type { GatewayClient } from "./client.js";

describe("startGatewayClientWhenEventLoopReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the client only after the event loop is responsive", async () => {
    vi.useFakeTimers();
    const client = { start: vi.fn() } as unknown as GatewayClient;

    const promise = startGatewayClientWhenEventLoopReady(client, { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(1);
    expect(client.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ ready: true });

    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("does not start the client after an aborted readiness wait", async () => {
    vi.useFakeTimers();
    const client = { start: vi.fn() } as unknown as GatewayClient;
    const controller = new AbortController();

    const promise = startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: 100,
      signal: controller.signal,
    });
    controller.abort();

    await expect(promise).resolves.toMatchObject({ ready: false, aborted: true });
    expect(client.start).not.toHaveBeenCalled();
  });
});
