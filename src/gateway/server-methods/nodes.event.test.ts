import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { nodeEventHandlers } from "./nodes.event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { recordHostStatsMock } = vi.hoisted(() => ({ recordHostStatsMock: vi.fn() }));
vi.mock("../../infra/device-pairing-node.js", () => ({
  recordPairedNodeHostStats: recordHostStatsMock,
}));

describe("node host stats receipt", () => {
  it.each([true, false])(
    "keeps the event result independent of persistence when the registry accepts=%s",
    async (accepted) => {
      const stats = { cpuCount: 2, memoryTotalBytes: 4096, memoryFreeBytes: 1024 };
      const hostStats = { ...stats, updatedAtMs: 1_250 };
      const persistence = createDeferred<boolean>();
      recordHostStatsMock.mockReset().mockReturnValue(persistence.promise);
      const session = { nodeId: "node-1", connId: "conn-1", pairingGeneration: "generation-1" };
      const warn = vi.fn();
      const broadcast = vi.fn();
      const updateHostStats = vi.fn(() => (accepted ? hostStats : null));
      const params = { event: "node.host.stats", payload: stats };
      const respond = vi.fn();
      await nodeEventHandlers["node.event"]!({
        req: { type: "req", id: "stats", method: "node.event", params },
        params,
        client: {
          connId: session.connId,
          connect: { device: { id: session.nodeId } },
        } as GatewayRequestHandlerOptions["client"],
        isWebchatConnect: () => false,
        respond,
        context: {
          nodeRegistry: {
            get: () => session,
            getForPairingGeneration: () => session,
            isConnectionCurrentPairingState: async () => true,
            updateHostStats,
          },
          broadcast,
          logGateway: { warn },
        } as unknown as GatewayRequestHandlerOptions["context"],
      });

      expect(updateHostStats).toHaveBeenCalledWith({ nodeId: "node-1", connId: "conn-1", stats });
      const result = [
        true,
        {
          ok: true,
          event: "node.host.stats",
          handled: accepted,
          reason: accepted ? "updated" : "stale_connection",
        },
        undefined,
      ];
      // The RPC has already completed while its store write is still pending.
      expect(respond.mock.calls).toEqual([result]);
      if (accepted) {
        expect(recordHostStatsMock).toHaveBeenCalledExactlyOnceWith({
          nodeId: session.nodeId,
          hostStats,
          expectedPairingGeneration: { nodeId: session.nodeId, key: session.pairingGeneration },
        });
        expect(broadcast).toHaveBeenCalledWith(
          "node.hostStats",
          { nodeId: session.nodeId, hostStats },
          { dropIfSlow: true },
        );
        persistence.reject(new Error("stats store unavailable"));
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "failed to persist node host stats for node-1: stats store unavailable",
          ),
        );
        expect(respond.mock.calls).toEqual([result]);
      } else {
        persistence.resolve(false);
        expect(recordHostStatsMock).not.toHaveBeenCalled();
        expect(broadcast).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );
});
