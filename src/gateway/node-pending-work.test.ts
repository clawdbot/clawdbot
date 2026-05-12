import { describe, expect, it, beforeEach } from "vitest";
import {
  acknowledgeNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  getNodePendingWorkStateCountForTests,
  resetNodePendingWorkForTests,
} from "./node-pending-work.js";

describe("node pending work", () => {
  beforeEach(() => {
    resetNodePendingWorkForTests();
  });

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

  it("dedupes explicit work by type and removes acknowledged items", () => {
    const first = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });
    const second = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    const drained = drainNodePendingWork("node-2");
    expect(drained.items.map((item) => item.type)).toEqual(["location.request", "status.request"]);

    const acked = acknowledgeNodePendingWork({
      nodeId: "node-2",
      itemIds: [first.item.id, "baseline-status"],
    });
    expect(acked.removedItemIds).toEqual([first.item.id]);

    const afterAck = drainNodePendingWork("node-2");
    expect(afterAck.items.map((item) => item.id)).toEqual(["baseline-status"]);
  });

  it("keeps hasMore true when the baseline status item is deferred by maxItems", () => {
    enqueueNodePendingWork({ nodeId: "node-3", type: "location.request" });

    const drained = drainNodePendingWork("node-3", { maxItems: 1 });

    expect(drained.items.map((item) => item.type)).toEqual(["location.request"]);
    expect(drained.hasMore).toBe(true);
  });

  it("does not allocate state for drain-only nodes with no queued work", () => {
    expect(getNodePendingWorkStateCountForTests()).toBe(0);

    const drained = drainNodePendingWork("node-4");
    const acked = acknowledgeNodePendingWork({ nodeId: "node-4", itemIds: ["baseline-status"] });

    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
    expect(acked).toEqual({ revision: 0, removedItemIds: [] });
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("prunes the state entry once all explicit items are acknowledged", () => {
    const { item } = enqueueNodePendingWork({ nodeId: "node-5", type: "status.request" });
    expect(getNodePendingWorkStateCountForTests()).toBe(1);

    acknowledgeNodePendingWork({ nodeId: "node-5", itemIds: [item.id] });
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("prunes the state entry when all items expire naturally via drain", () => {
    enqueueNodePendingWork({ nodeId: "node-6", type: "location.request", expiresInMs: 5_000 });
    expect(getNodePendingWorkStateCountForTests()).toBe(1);

    // Drain well after the item has expired (Date.now() + 60s > enqueue time + 5s)
    drainNodePendingWork("node-6", { nowMs: Date.now() + 60_000 });
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });
});
