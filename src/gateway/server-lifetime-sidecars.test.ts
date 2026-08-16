import { describe, expect, test, vi } from "vitest";
import { mergeGatewaySidecarOwners } from "./server-sidecar-owners.js";

describe("gateway lifetime sidecars", () => {
  test("keeps pre-published sidecars reachable by shutdown", async () => {
    const metadataListener = { stop: vi.fn(async () => {}) };
    const sessionChange = { stop: vi.fn(async () => {}) };
    const worker = { stop: vi.fn(async () => {}) };

    const sidecars = mergeGatewaySidecarOwners({
      registered: [metadataListener, sessionChange],
      published: [worker, metadataListener],
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
