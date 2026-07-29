/**
 * Node pending-work tracking tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  clearNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  removeNodePendingWorkItem,
} from "./node-pending-work.js";

describe("node pending work", () => {
  it("returns a baseline status request even when no explicit work is queued", () => {
    const drained = drainNodePendingWork("node-1");
    expect(drained.items).toHaveLength(1);
    expect(drained.items[0]?.id).toBe("baseline-status");
    expect(drained.items[0]?.type).toBe("status.request");
    expect(drained.items[0]?.priority).toBe("default");
    expect(typeof drained.items[0]?.createdAtMs).toBe("number");
    expect(drained.items[0]?.expiresAtMs).toBeNull();
    expect(drained.hasMore).toBe(false);
  });

  it("dedupes explicit work by type until the node drains it", () => {
    const first = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });
    const second = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    const drained = drainNodePendingWork("node-2");
    expect(drained.items.map((item) => item.type)).toEqual(["location.request", "status.request"]);

    const afterDrain = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });
    expect(afterDrain.deduped).toBe(false);
    expect(afterDrain.item.id).not.toBe(first.item.id);
    drainNodePendingWork("node-2");
  });

  it("clears explicit work when a pairing is removed", () => {
    enqueueNodePendingWork({ nodeId: "node-removed", type: "location.request" });

    expect(clearNodePendingWork(" node-removed ")).toBe(true);
    expect(drainNodePendingWork("node-removed").items.map((item) => item.id)).toEqual([
      "baseline-status",
    ]);
    expect(clearNodePendingWork("node-removed")).toBe(false);
  });

  it("keeps explicit work isolated from a replacement pairing generation", () => {
    enqueueNodePendingWork({
      nodeId: "node-replaced",
      type: "location.request",
      pairingGeneration: "generation-1",
    });

    const drained = drainNodePendingWork("node-replaced", {
      pairingGeneration: "generation-2",
    });

    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
    expect(
      drainNodePendingWork("node-replaced", { pairingGeneration: "generation-1" }).items.map(
        (item) => item.type,
      ),
    ).toEqual(["location.request", "status.request"]);
  });

  it("prunes expired work from retired generations on current-generation access", () => {
    enqueueNodePendingWork({
      nodeId: "node-retired-generation",
      type: "location.request",
      expiresInMs: 1_000,
      pairingGeneration: "generation-1",
    });

    drainNodePendingWork("node-retired-generation", {
      pairingGeneration: "generation-2",
      nowMs: Date.now() + 2_000,
    });

    expect(clearNodePendingWork("node-retired-generation", "generation-1")).toBe(false);
  });

  it("does not let a stale drain delete replacement-generation work", () => {
    enqueueNodePendingWork({
      nodeId: "node-stale-drain",
      type: "location.request",
      pairingGeneration: "generation-2",
    });

    expect(
      drainNodePendingWork("node-stale-drain", { pairingGeneration: "generation-1" }).items.map(
        (item) => item.id,
      ),
    ).toEqual(["baseline-status"]);
    expect(
      drainNodePendingWork("node-stale-drain", { pairingGeneration: "generation-2" }).items.map(
        (item) => item.type,
      ),
    ).toEqual(["location.request", "status.request"]);
  });

  it("rolls back only the exact item owned by one enqueue", () => {
    const location = enqueueNodePendingWork({
      nodeId: "node-item-rollback",
      type: "location.request",
      pairingGeneration: "generation-1",
    });
    enqueueNodePendingWork({
      nodeId: "node-item-rollback",
      type: "status.request",
      pairingGeneration: "generation-1",
    });

    expect(
      removeNodePendingWorkItem({
        nodeId: "node-item-rollback",
        itemId: location.item.id,
        pairingGeneration: "generation-1",
      }),
    ).toBe(true);
    expect(
      drainNodePendingWork("node-item-rollback", {
        pairingGeneration: "generation-1",
        includeDefaultStatus: false,
      }).items.map((item) => item.type),
    ).toEqual(["status.request"]);
  });

  it("keeps hasMore true when the baseline status item is deferred by maxItems", () => {
    enqueueNodePendingWork({ nodeId: "node-3", type: "location.request" });

    const drained = drainNodePendingWork("node-3", { maxItems: 1 });

    expect(drained.items.map((item) => item.type)).toEqual(["location.request"]);
    expect(drained.hasMore).toBe(true);

    const next = drainNodePendingWork("node-3", { maxItems: 1 });
    expect(next.items.map((item) => item.id)).toEqual(["baseline-status"]);
    expect(next.hasMore).toBe(false);
  });

  it("keeps explicit work queued when maxItems defers it", () => {
    enqueueNodePendingWork({ nodeId: "node-4", type: "status.request", priority: "normal" });
    enqueueNodePendingWork({ nodeId: "node-4", type: "location.request", priority: "high" });

    const firstDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(firstDrain.items.map((item) => item.type)).toEqual(["location.request"]);
    expect(firstDrain.hasMore).toBe(true);

    const secondDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(secondDrain.items.map((item) => item.type)).toEqual(["status.request"]);
    expect(secondDrain.items.map((item) => item.id)).not.toEqual(["baseline-status"]);
    expect(secondDrain.hasMore).toBe(false);
  });

  it("assigns default expiry to queued work without explicit ttl", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const expiresAtMs = (() => {
      try {
        const { item } = enqueueNodePendingWork({
          nodeId: "node-default-expiry",
          type: "location.request",
        });
        expect(item.expiresAtMs).toBe(1_000 + 24 * 60 * 60_000);
        if (typeof item.expiresAtMs !== "number") {
          throw new Error("expected queued work expiry");
        }
        return item.expiresAtMs;
      } finally {
        dateNow.mockRestore();
      }
    })();

    const drained = drainNodePendingWork("node-default-expiry", { nowMs: expiresAtMs });
    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
  });

  it("expires explicit work naturally via drain", () => {
    const queued = enqueueNodePendingWork({
      nodeId: "node-7",
      type: "location.request",
      expiresInMs: 5_000,
    });

    const drained = drainNodePendingWork("node-7", { nowMs: Date.now() + 60_000 });

    expect(drained.revision).toBeGreaterThan(queued.revision);
    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
  });

  it("expires timed pending work immediately when the enqueue clock is invalid", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      const { item } = enqueueNodePendingWork({
        nodeId: "node-invalid-clock",
        type: "location.request",
        expiresInMs: 5_000,
      });
      expect(item.createdAtMs).toBe(0);
      expect(item.expiresAtMs).toBe(0);
    } finally {
      dateNow.mockRestore();
    }

    expect(
      drainNodePendingWork("node-invalid-clock", { nowMs: 1_000 }).items.map((item) => item.id),
    ).toEqual(["baseline-status"]);
  });

  it("expires timed pending work immediately when expiry would exceed Date bounds", () => {
    const { item } = enqueueNodePendingWork({
      nodeId: "node-8",
      type: "location.request",
      expiresInMs: Number.MAX_SAFE_INTEGER,
    });
    expect(item.expiresAtMs).toBe(0);

    expect(
      drainNodePendingWork("node-8", { nowMs: Date.now() }).items.map((entry) => entry.id),
    ).toEqual(["baseline-status"]);
  });
});
