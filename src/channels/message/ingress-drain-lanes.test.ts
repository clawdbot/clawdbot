import { describe, expect, it, vi } from "vitest";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain lanes", () => {
  it("preserves rejected stored lanes and attempts each snapshot candidate once", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("active", { text: "topic" }, { laneKey: "topic" });
      let releaseActive: (() => void) | undefined;
      const activeDone = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deriveLaneKey: (record) => record.payload.text,
        reconcileStoredLaneKey: () => false,
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          if (event.id === "active") {
            await activeDone;
          }
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active"]));
      await queue.enqueue("candidate", { text: "topic" }, { laneKey: "control" });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active", "candidate"]));
      await expect(queue.enqueue("candidate", { text: "topic" })).resolves.toMatchObject({
        kind: "completed",
      });

      releaseActive?.();
      await drain.waitForIdle();
      drain.dispose();
    });
  });

  // LINE-shaped lanes: one user/group id owns a lane, so a lane head parked behind
  // a newer failing sibling reads to the sender as an ignored message.
  it("starts an eligible lane head while a newer same-lane event waits out its retry backoff", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await queue.enqueue("head", { text: "head" }, { laneKey: "user:U1", receivedAt: 1_000 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "user:U1", receivedAt: 2_000 });
      const tailClaim = await queue.claim("tail");
      expect(tailClaim).not.toBeNull();
      await queue.release(tailClaim!, { lastError: "boom", releasedAt: currentNow });

      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["head"]));

      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("keeps the lane blocked while its oldest pending event is retry-delayed", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await queue.enqueue("head", { text: "head" }, { laneKey: "user:U1", receivedAt: 1_000 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "user:U1", receivedAt: 2_000 });
      const headClaim = await queue.claim("head");
      expect(headClaim).not.toBeNull();
      await queue.release(headClaim!, { lastError: "boom", releasedAt: currentNow });

      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 0 });
      expect(dispatches).toEqual([]);

      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("never claims a retry-delayed event whose lane head settled after the drain snapshot", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const currentNow = 10_000_000;
      await queue.enqueue("head", { text: "head" }, { laneKey: "user:U1", receivedAt: 1_000 });
      await queue.enqueue("tail", { text: "tail" }, { laneKey: "user:U1", receivedAt: 2_000 });
      const tailClaim = await queue.claim("tail");
      await queue.release(tailClaim!, { lastError: "boom", releasedAt: currentNow });

      // Snapshot keeps the eligible head, then a sibling drainer settles it. The
      // freed lane must not hand the still-delayed tail an early attempt.
      const snapshot = await queue.listPending({ limit: "all", orderBy: "received" });
      const headClaim = await queue.claim("head");
      expect(headClaim).not.toBeNull();
      await queue.complete(headClaim!);
      vi.spyOn(queue, "listPending").mockResolvedValue(snapshot);

      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => currentNow,
        retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await expect(drain.drainOnce()).resolves.toEqual({ started: 0 });
      expect(dispatches).toEqual([]);

      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
