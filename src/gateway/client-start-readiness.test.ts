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
    const readiness = await promise;
    expect(readiness.ready).toBe(true);
    expect(readiness.aborted).toBe(false);

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

    const readiness = await promise;
    expect(readiness.ready).toBe(false);
    expect(readiness.aborted).toBe(true);
    expect(client.start).not.toHaveBeenCalled();
  });
});
