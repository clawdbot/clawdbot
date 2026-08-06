import { describe, expect, it, vi } from "vitest";
import type { NodeHostClient } from "./client.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";

const frame = {
  id: "invoke-1",
  nodeId: "node-1",
  command: "test.duplex",
  paramsJSON: null,
  timeoutMs: 0,
  idempotencyKey: null,
};

describe("node invoke progress writer", () => {
  it("chunks output to 16 KiB and pauses its producer for backpressure", async () => {
    const request = vi.fn(async () => ({}));
    const client = { request } as NodeHostClient;
    const pausable = { pause: vi.fn(), resume: vi.fn() };
    const writer = createNodeInvokeProgressWriter({
      client,
      frame,
      idleTimeoutMs: 30_000,
      onError: vi.fn(),
    });

    await writer.write("é".repeat(10_000), pausable);
    expect(request).toHaveBeenCalledTimes(2);
    expect(pausable.pause).toHaveBeenCalledOnce();
    expect(pausable.resume).toHaveBeenCalledOnce();
    for (const [, params] of request.mock.calls as unknown as Array<[string, { chunk: string }]>) {
      expect(Buffer.byteLength(params.chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it.each([
    { idleTimeoutMs: 100, heartbeatIntervalMs: 250 },
    { idleTimeoutMs: 2_000, heartbeatIntervalMs: 1_000 },
    { idleTimeoutMs: 60_000, heartbeatIntervalMs: 5_000 },
  ])(
    "emits idle heartbeats every $heartbeatIntervalMs ms for a $idleTimeoutMs ms timeout",
    async ({ idleTimeoutMs, heartbeatIntervalMs }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const request = vi.fn(async () => ({}));
        const writer = createNodeInvokeProgressWriter({
          client: { request } as NodeHostClient,
          frame,
          idleTimeoutMs,
          onError: vi.fn(),
        });
        writer.startHeartbeats();
        await vi.advanceTimersByTimeAsync(heartbeatIntervalMs - 1);
        expect(request).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledWith("node.invoke.progress", {
          invokeId: "invoke-1",
          nodeId: "node-1",
          seq: 0,
          chunk: "",
        });
        writer.stop();
        await writer.flush();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
