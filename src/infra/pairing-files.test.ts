// Covers shared pairing file helpers.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  pruneExpiredPending,
  reconcilePendingPairingRequests,
  resolvePairingPaths,
} from "./pairing-files.js";

describe("pairing file helpers", () => {
  it("resolves pairing file paths from explicit base dirs", () => {
    expect(resolvePairingPaths("/tmp/openclaw-state", "devices")).toEqual({
      dir: path.join("/tmp/openclaw-state", "devices"),
      pendingPath: path.join("/tmp/openclaw-state", "devices", "pending.json"),
      pairedPath: path.join("/tmp/openclaw-state", "devices", "paired.json"),
    });
  });

  it("prunes only entries older than the ttl", () => {
    const pendingById = {
      stale: { ts: 10, requestId: "stale" },
      edge: { ts: 50, requestId: "edge" },
      fresh: { ts: 70, requestId: "fresh" },
    };

    pruneExpiredPending(pendingById, 100, 50);

    expect(pendingById).toEqual({
      edge: { ts: 50, requestId: "edge" },
      fresh: { ts: 70, requestId: "fresh" },
    });
  });

  it("refreshes a single matching pending request in place", async () => {
    const persist = vi.fn(async () => undefined);
    const existing = { requestId: "req-1", deviceId: "device-1", ts: 1, version: 1 };
    const pendingById = { "req-1": existing };

    await expect(
      reconcilePendingPairingRequests({
        pendingById,
        existing: [existing],
        incoming: { version: 2 },
        canRefreshSingle: () => true,
        refreshSingle: (pending, incoming) => ({ ...pending, version: incoming.version, ts: 2 }),
        buildReplacement: vi.fn(() => ({ requestId: "req-2", deviceId: "device-1", ts: 2 })),
        persist,
      }),
    ).resolves.toEqual({
      status: "pending",
      request: { requestId: "req-1", deviceId: "device-1", ts: 2, version: 2 },
      created: false,
    });
    expect(persist).toHaveBeenCalledOnce();
  });

  it("replaces existing pending requests with one merged request", async () => {
    const persist = vi.fn(async () => undefined);
    const pendingById = {
      "req-1": { requestId: "req-1", deviceId: "device-2", ts: 1 },
      "req-2": { requestId: "req-2", deviceId: "device-2", ts: 2 },
    };

    await expect(
      reconcilePendingPairingRequests({
        pendingById,
        existing: Object.values(pendingById).toSorted((left, right) => right.ts - left.ts),
        incoming: { deviceId: "device-2" },
        canRefreshSingle: () => false,
        refreshSingle: (pending) => pending,
        buildReplacement: vi.fn(() => ({
          requestId: "req-3",
          deviceId: "device-2",
          ts: 3,
          isRepair: true,
        })),
        persist,
      }),
    ).resolves.toEqual({
      status: "pending",
      request: { requestId: "req-3", deviceId: "device-2", ts: 3, isRepair: true },
      created: true,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(pendingById).toEqual({
      "req-3": { requestId: "req-3", deviceId: "device-2", ts: 3, isRepair: true },
    });
  });
});
