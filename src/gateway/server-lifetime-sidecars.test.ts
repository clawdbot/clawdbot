import { describe, expect, test, vi } from "vitest";
import { publishGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";

describe("gateway lifetime sidecars", () => {
  test("keeps pre-published sidecars reachable by shutdown", async () => {
    const metadataListener = { stop: vi.fn(async () => {}) };
    const sessionChange = { stop: vi.fn(async () => {}) };
    const worker = { stop: vi.fn(async () => {}) };

    const sidecars = publishGatewayLifetimeSidecars({
      registered: [metadataListener, sessionChange],
      published: [worker, metadataListener],
      closeStarted: false,
      stopAfterCloseStarted: vi.fn(),
    });
    expect(sidecars).toEqual([metadataListener, sessionChange, worker]);

    for (const sidecar of sidecars) {
      await sidecar.stop();
    }
    expect(metadataListener.stop).toHaveBeenCalledOnce();
    expect(sessionChange.stop).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
  });
});
