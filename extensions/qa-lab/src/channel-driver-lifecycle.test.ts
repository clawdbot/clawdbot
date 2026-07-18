import { describe, expect, it, vi } from "vitest";
import {
  createQaChannelDriverLifecycle,
  runQaChannelDriverLifecycleScenarios,
} from "./channel-driver-lifecycle.js";
import type { QaTransportAdapter } from "./qa-transport.js";

describe("QA channel driver lifecycle", () => {
  it("runs all lifecycle scenarios through create and cleanup", async () => {
    const runtimes: Array<{
      adapter: QaTransportAdapter;
      cleanupBeforeGatewayStop: () => Promise<void>;
      cleanupAfterGatewayStop: () => Promise<void>;
      cleanupWithoutGateway: () => Promise<void>;
    }> = [];
    const createAdapter = vi.fn(async () => {
      const id = runtimes.length + 1;
      const runtime = {
        adapter: { id: String(id) } as QaTransportAdapter,
        cleanupBeforeGatewayStop: vi.fn(async () => {}),
        cleanupAfterGatewayStop: vi.fn(async () => {}),
        cleanupWithoutGateway: vi.fn(async () => {}),
      };
      runtimes.push(runtime);
      return runtime;
    });
    const lifecycle = createQaChannelDriverLifecycle(
      { channelId: "matrix", driver: "live", outputDir: "/tmp/matrix-lifecycle" },
      { createAdapter, listAdapterFactories: () => [] },
    );
    const probedIds: number[] = [];
    const stoppedIds: number[] = [];

    const results = await runQaChannelDriverLifecycleScenarios({
      async assertStopped(runtime) {
        expect(runtime.cleanupWithoutGateway).toHaveBeenCalledOnce();
        stoppedIds.push(Number(runtime.adapter.id));
      },
      lifecycle,
      async probe(runtime) {
        probedIds.push(Number(runtime.adapter.id));
      },
    });

    expect(results).toEqual(["cold-start", "idempotent-start", "restart", "stop", "resume"]);
    expect(probedIds).toEqual([1, 1, 2, 3]);
    expect(stoppedIds).toEqual([1, 2]);
    expect(createAdapter).toHaveBeenCalledTimes(3);
    expect(lifecycle.state).toEqual({ runtime: runtimes[2], status: "running" });
  });

  it("keeps the running adapter when cleanup fails", async () => {
    const runtime = {
      adapter: {} as QaTransportAdapter,
      cleanupBeforeGatewayStop: vi.fn(async () => {}),
      cleanupAfterGatewayStop: vi.fn(async () => {}),
      cleanupWithoutGateway: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    };
    const lifecycle = createQaChannelDriverLifecycle(
      { channelId: "matrix", driver: "live", outputDir: "/tmp/matrix-lifecycle" },
      { createAdapter: async () => runtime, listAdapterFactories: () => [] },
    );

    await lifecycle.start();
    await expect(lifecycle.stop()).rejects.toThrow("cleanup failed");
    expect(lifecycle.state).toEqual({ runtime, status: "running" });
  });
});
