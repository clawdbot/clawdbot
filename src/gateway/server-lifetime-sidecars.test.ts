import { describe, expect, test, vi } from "vitest";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

describe("gateway lifetime sidecars", () => {
  test("keeps pre-published sidecars reachable by shutdown", async () => {
    const metadataListener = { stop: vi.fn(async () => {}) };
    const sessionChange = { stop: vi.fn(async () => {}) };
    const worker = { stop: vi.fn(async () => {}) };

    let sidecars: GatewayPostReadySidecarHandle[] = [metadataListener, sessionChange];
    const owner = createGatewaySidecarStopOwner({
      getRegistered: () => sidecars,
      setRegistered: (next) => {
        sidecars = next;
      },
    });
    owner.publish([worker, metadataListener]);
    expect(sidecars).toEqual([metadataListener, sessionChange, worker]);

    await owner.stop();
    expect(metadataListener.stop).toHaveBeenCalledOnce();
    expect(sessionChange.stop).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
  });
});
