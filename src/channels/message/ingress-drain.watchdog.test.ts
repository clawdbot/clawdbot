import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain, isIngressAdoptionLostError } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries pre-adoption stalls in lane order and fences late adoption", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall", { text: "x" }, { laneKey: "l1" });
      await queue.enqueue("evt-next", { text: "next" }, { laneKey: "l1", receivedAt: clock + 1 });
      const dispatched: string[] = [];
      let stalledLifecycle: ChannelIngressDispatchLifecycle | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          if (!stalledLifecycle) {
            stalledLifecycle = lifecycle;
            await new Promise(() => {});
          }
          await lifecycle.onAdopted();
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.listPending({ limit: "all", orderBy: "received" })).toMatchObject([
        { id: "evt-stall", attempts: 1, lastError: expect.stringContaining("handler-timeout") },
        { id: "evt-next", attempts: 0 },
      ]);
      await expect(stalledLifecycle?.onAdopted()).rejects.toSatisfy(isIngressAdoptionLostError);

      expect(await drain.drainOnce()).toEqual({ started: 0 });
      clock += 1_000;
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(dispatched).toEqual(["evt-stall", "evt-stall", "evt-next"]);
      drain.dispose();
    });
  });

  it("guillotines deferred stalls", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-stall", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.onDeferred();
          // Stay deferred without adoption -- watchdog must still fire.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      expect(await queue.listClaims()).toHaveLength(1);
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        {
          id: "evt-def-stall",
          attempts: 1,
          lastError: expect.stringContaining("handler-timeout"),
        },
      ]);
      drain.dispose();
    });
  });

  it("lets a released deferred lifecycle own settlement without a watchdog", async () => {
    await withTempState(async (stateDir) => {
      let clock = 40_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-lifecycle-owned", { text: "x" }, { laneKey: "l1" });
      let adopt: (() => void | Promise<void>) | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 1_000,
        deferredLaneOccupancy: "release-until-settled",
        dispatchClaimedEvent: async (_event, lifecycle) => {
          adopt = lifecycle.onAdopted;
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      await vi.waitFor(() => expect(drain.activeLaneKeys()).toEqual(new Set()));
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await queue.listFailed?.()).toEqual([]);
      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["evt-lifecycle-owned"]);

      await adopt?.();
      await expect(queue.enqueue("evt-lifecycle-owned", { text: "x" })).resolves.toMatchObject({
        kind: "completed",
      });
      drain.dispose();
    });
  });

  it("does not kill healthy long turns after adoption", async () => {
    await withTempState(async (stateDir) => {
      let clock = 20_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-long", { text: "x" }, { laneKey: "l1" });

      let settleResolve!: () => void;
      const settleGate = new Promise<void>((resolve) => {
        settleResolve = resolve;
      });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 1_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await lifecycle.onAdopted();
          await settleGate;
        },
      });

      await drain.drainOnce();
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toEqual([]);
      });
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      const status = await queue.enqueue("evt-long", { text: "x" });
      expect(status.kind).toBe("completed");
      settleResolve();
      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
