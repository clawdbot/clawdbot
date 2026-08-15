import { describe, expect, it, vi } from "vitest";
import {
  createQaChannelDriverLifecycle,
  runQaChannelDriverLifecycleScenarios,
  type QaChannelDriverRuntime,
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

  it("shares one adapter between concurrent starts", async () => {
    const runtime: QaChannelDriverRuntime = {
      adapter: { id: "shared" } as QaTransportAdapter,
      cleanupBeforeGatewayStop: vi.fn(async () => {}),
      cleanupAfterGatewayStop: vi.fn(async () => {}),
      cleanupWithoutGateway: vi.fn(async () => {}),
    };
    const createAdapter = vi.fn(async () => runtime);
    const lifecycle = createQaChannelDriverLifecycle(
      { channelId: "matrix", driver: "live", outputDir: "/tmp/matrix-lifecycle" },
      { createAdapter, listAdapterFactories: () => [] },
    );

    const runtimes = await Promise.all([lifecycle.start(), lifecycle.start(), lifecycle.start()]);

    expect(runtimes).toEqual([runtime, runtime, runtime]);
    expect(createAdapter).toHaveBeenCalledOnce();
    expect(lifecycle.state).toEqual({ runtime, status: "running" });
  });

  it("cleans an adapter when stop arrives during startup", async () => {
    const runtime: QaChannelDriverRuntime = {
      adapter: { id: "pending" } as QaTransportAdapter,
      cleanupBeforeGatewayStop: vi.fn(async () => {}),
      cleanupAfterGatewayStop: vi.fn(async () => {}),
      cleanupWithoutGateway: vi.fn(async () => {}),
    };
    let resolveStartup: (runtime: QaChannelDriverRuntime) => void = () => {};
    const startup = new Promise<QaChannelDriverRuntime>((resolve) => {
      resolveStartup = resolve;
    });
    const createAdapter = vi.fn(() => startup);
    const lifecycle = createQaChannelDriverLifecycle(
      { channelId: "matrix", driver: "live", outputDir: "/tmp/matrix-lifecycle" },
      { createAdapter, listAdapterFactories: () => [] },
    );

    const starting = lifecycle.start();
    await vi.waitFor(() => expect(createAdapter).toHaveBeenCalledOnce());
    const stopping = lifecycle.stop();
    resolveStartup(runtime);

    await expect(starting).resolves.toBe(runtime);
    await expect(stopping).resolves.toBeUndefined();
    expect(runtime.cleanupWithoutGateway).toHaveBeenCalledOnce();
    expect(lifecycle.state).toEqual({ status: "stopped" });
  });

  it("retries startup after a failed lifecycle transition", async () => {
    const runtime: QaChannelDriverRuntime = {
      adapter: { id: "recovered" } as QaTransportAdapter,
      cleanupBeforeGatewayStop: vi.fn(async () => {}),
      cleanupAfterGatewayStop: vi.fn(async () => {}),
      cleanupWithoutGateway: vi.fn(async () => {}),
    };
    const createAdapter = vi
      .fn<() => Promise<QaChannelDriverRuntime>>()
      .mockRejectedValueOnce(new Error("adapter startup failed"))
      .mockResolvedValueOnce(runtime);
    const lifecycle = createQaChannelDriverLifecycle(
      { channelId: "matrix", driver: "live", outputDir: "/tmp/matrix-lifecycle" },
      { createAdapter, listAdapterFactories: () => [] },
    );

    await expect(lifecycle.start()).rejects.toThrow("adapter startup failed");
    await expect(lifecycle.start()).resolves.toBe(runtime);
    expect(createAdapter).toHaveBeenCalledTimes(2);
    expect(lifecycle.state).toEqual({ runtime, status: "running" });
  });

  it("finishes each restart before starting the next transition", async () => {
    const events: string[] = [];
    let nextId = 0;
    const createAdapter = vi.fn(async (): Promise<QaChannelDriverRuntime> => {
      const id = String(++nextId);
      events.push(`start:${id}`);
      return {
        adapter: { id } as QaTransportAdapter,
        cleanupBeforeGatewayStop: vi.fn(async () => {}),
        cleanupAfterGatewayStop: vi.fn(async () => {}),
        cleanupWithoutGateway: vi.fn(async () => {
          events.push(`stop:${id}`);
        }),
      };
    });
    const lifecycle = createQaChannelDriverLifecycle(
      { channelId: "matrix", driver: "live", outputDir: "/tmp/matrix-lifecycle" },
      { createAdapter, listAdapterFactories: () => [] },
    );
    await lifecycle.start();

    const [firstRestart, secondRestart] = await Promise.all([
      lifecycle.restart(),
      lifecycle.restart(),
    ]);

    expect(firstRestart.adapter.id).toBe("2");
    expect(secondRestart.adapter.id).toBe("3");
    expect(events).toEqual(["start:1", "stop:1", "start:2", "stop:2", "start:3"]);
    expect(lifecycle.state).toEqual({ runtime: secondRestart, status: "running" });
  });
});
