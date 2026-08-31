import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain, isIngressAdoptionLostError } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

async function deferNext(
  queue: ReturnType<typeof createTestIngressQueue>,
  abortSignal?: AbortSignal,
  adoptionStallTimeoutMs = 1_000,
) {
  const lifecycles: ChannelIngressDispatchLifecycle[] = [];
  const drain = createChannelIngressDrain({
    queue,
    abortSignal,
    adoptionStallTimeoutMs,
    dispatchClaimedEvent: async (_event, lifecycle) => {
      lifecycles.push(lifecycle);
      return { kind: "deferred" };
    },
  });
  await drain.drainOnce();
  await drain.waitForIdle();
  const lifecycle = expectDefined(lifecycles[0], "deferred lifecycle");
  return {
    drain,
    lifecycle,
    heartbeat: expectDefined(lifecycle.onDeferredHeartbeat, "deferred heartbeat"),
  };
}

describe("channel ingress drain watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
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

  it("rearms a live deferred wait, then guillotines silence", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-stall", { text: "x" }, { laneKey: "l1" });
      let heartbeat: (() => void) | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.onDeferred();
          heartbeat = lifecycle.onDeferredHeartbeat;
          // Stay deferred without adoption -- watchdog must still fire.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      expect(await queue.listClaims()).toHaveLength(1);
      clock += 4_000;
      await vi.advanceTimersByTimeAsync(4_000);
      heartbeat?.();
      clock += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await queue.listClaims()).toHaveLength(1);
      clock += 4_000;
      await vi.advanceTimersByTimeAsync(4_000);
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

  it.each([
    { stop: "dispose", heartbeat: "none" },
    { stop: "dispose", heartbeat: "late" },
    { stop: "dispose", heartbeat: "reentrant" },
    { stop: "abort", heartbeat: "none" },
    { stop: "abort", heartbeat: "late" },
    { stop: "abort", heartbeat: "reentrant" },
  ])("preserves retry facts after $stop (heartbeat: $heartbeat)", async ({ stop, heartbeat }) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("retired", { text: "deferred" }, { laneKey: "lane" });
      const abort = new AbortController();
      const owner = await deferNext(queue, abort.signal);
      try {
        const before = await queue.listClaims();
        expect(before).toHaveLength(1);
        if (heartbeat === "reentrant") {
          owner.lifecycle.abortSignal.addEventListener("abort", owner.heartbeat, { once: true });
        }
        if (stop === "dispose") {
          owner.drain.dispose();
        } else {
          abort.abort(new Error("monitor stopped"));
        }
        expect(owner.lifecycle.abortSignal.aborted).toBe(true);
        const stoppedTimers = vi.getTimerCount();
        if (heartbeat === "late") {
          owner.heartbeat();
        }
        const lateTimers = vi.getTimerCount();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await queue.listClaims()).toEqual(before);
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([]);
        expect(lateTimers).toBe(stoppedTimers);

        // A real late adoption still commits; stopping only retires watchdog work.
        await owner.lifecycle.onAdopted();
        expect((await queue.enqueue("retired", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        owner.drain.dispose();
      }
    });
  });

  it.each([
    { terminal: "cancelled", attempts: 0, lastError: undefined },
    { terminal: "abandoned", attempts: 1, lastError: "turn-abandoned" },
    { terminal: "failed", attempts: 1, lastError: "provider failed" },
  ])(
    "records a late $terminal outcome after disposal",
    async ({ terminal, attempts, lastError }) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("terminal", { text: "deferred" }, { laneKey: "lane" });
        const owner = await deferNext(queue);
        try {
          owner.drain.dispose();
          if (terminal === "cancelled") {
            await expectDefined(owner.lifecycle.onCancelled, "cancel callback")();
          } else if (terminal === "abandoned") {
            await owner.lifecycle.onAbandoned();
          } else {
            await expectDefined(
              owner.lifecycle.onFailed,
              "failure callback",
            )(new Error("provider failed"));
          }
          owner.heartbeat();
          await vi.advanceTimersByTimeAsync(1_100);
          expect(await queue.listClaims()).toEqual([]);
          const pending = await queue.listPending();
          expect(pending).toHaveLength(1);
          expect(pending[0]?.attempts).toBe(attempts);
          expect(pending[0]?.lastError).toBe(lastError);
        } finally {
          owner.drain.dispose();
        }
      });
    },
  );

  it("keeps a successor claim fenced from retired callbacks", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("replacement", { text: "deferred" }, { laneKey: "lane" });
      const old = await deferNext(queue);
      const retired = await queue.listClaims();
      old.drain.dispose();
      const next = await deferNext(queue, undefined, 60_000);
      try {
        const before = await queue.listClaims();
        expect(before).toHaveLength(1);
        expect(before[0]?.claim.token).not.toBe(retired[0]?.claim.token);
        old.heartbeat();
        await vi.advanceTimersByTimeAsync(1_100);
        expect(await queue.listClaims()).toEqual(before);
        expect(await queue.listPending()).toEqual([]);
        await expect(old.lifecycle.onAdopted()).rejects.toSatisfy(isIngressAdoptionLostError);
        await next.lifecycle.onAdopted();
        expect((await queue.enqueue("replacement", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        old.drain.dispose();
        next.drain.dispose();
      }
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
