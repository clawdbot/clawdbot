import { describe, expect, it, vi } from "vitest";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain supersede", () => {
  it("supersedes every released pre-adoption state on one lane", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("album-1", { text: "first" }, { laneKey: "shared" });
      await queue.enqueue("album-2", { text: "second" }, { laneKey: "shared" });
      const signals = new Map<string, AbortSignal>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        shouldSupersedePending: (candidate) => candidate.id === "abort",
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "abort") {
            await lifecycle.onAdopted();
            return { kind: "completed" };
          }
          signals.set(event.id, lifecycle.abortSignal);
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(signals.size).toBe(1));
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(signals.size).toBe(2));
      expect(await queue.listClaims()).toHaveLength(2);

      await queue.enqueue("abort", { text: "/abort" }, { laneKey: "shared" });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();

      expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
      expect(await queue.listClaims()).toEqual([]);
      for (const id of ["album-1", "album-2", "abort"]) {
        expect((await queue.enqueue(id, { text: id })).kind).toBe("completed");
      }
      drain.dispose();
    });
  });

  it("preserves single-owner supersede behavior with default lane holding", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "old" }, { laneKey: "shared" });
      const predicatePendingIds: string[] = [];
      let oldSignal: AbortSignal | undefined;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        shouldSupersedePending: (candidate, pending) => {
          predicatePendingIds.push(pending.id);
          return candidate.id === "new";
        },
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "old") {
            oldSignal = lifecycle.abortSignal;
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      await drain.drainOnce();
      await queue.enqueue("new", { text: "new" }, { laneKey: "shared" });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();

      expect(predicatePendingIds).toEqual(["old"]);
      expect(oldSignal?.aborted).toBe(true);
      expect((await queue.enqueue("old", { text: "old" })).kind).toBe("completed");
      expect((await queue.enqueue("new", { text: "new" })).kind).toBe("completed");
      drain.dispose();
    });
  });

  it("keeps the candidate blocked when a current lane owner is not superseded", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("released", { text: "released" }, { laneKey: "shared" });
      await queue.enqueue("owner", { text: "owner" }, { laneKey: "shared" });
      let releaseOwner!: () => void;
      const ownerGate = new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      const signals = new Map<string, AbortSignal>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        shouldSupersedePending: (candidate, pending) =>
          candidate.id === "abort" && pending.id === "released",
        dispatchClaimedEvent: async (event, lifecycle) => {
          signals.set(event.id, lifecycle.abortSignal);
          if (event.id === "released") {
            return { kind: "deferred" };
          }
          await ownerGate;
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      await drain.drainOnce();
      await vi.waitFor(() => expect(signals.has("released")).toBe(true));
      await drain.drainOnce();
      await vi.waitFor(() => expect(signals.has("owner")).toBe(true));
      await queue.enqueue("abort", { text: "/abort" }, { laneKey: "shared" });

      expect(await drain.drainOnce()).toEqual({ started: 0 });
      expect(signals.get("released")?.aborted).toBe(true);
      expect(signals.get("owner")?.aborted).toBe(false);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "abort",
      ]);
      releaseOwner();
      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
