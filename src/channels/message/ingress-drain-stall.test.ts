// Pre-adoption stall watchdog contract tests: cancellation, ownership fencing,
// retry preservation, and dead-letter escalation.
//
// Split out of ingress-drain.test.ts (which is at its max-lines budget) to match
// the ingress-drain-stall-watchdog.ts source extraction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain, DEFAULT_INGRESS_ADOPTION_STALL_MS } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain: pre-adoption stall watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("requeues a pre-adoption stall for retry once the aborted dispatch exits", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall-requeue", { text: "user message" }, { laneKey: "l1" });

      let dispatches = 0;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        // No retryPolicy override: defaults must preserve the inbound message.
        dispatchClaimedEvent: async (_event, lifecycle) => {
          dispatches += 1;
          // Cooperative dispatch: observes the abort and exits.
          await new Promise<void>((resolve) => {
            if (lifecycle.abortSignal.aborted) {
              resolve();
              return;
            }
            lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      // The stalled event must NOT be dead-lettered: it was never handled, so
      // destroying it silently loses a user message.
      const failed = await queue.listFailed?.();
      expect(failed ?? []).toHaveLength(0);
      expect(dispatches).toBe(1);

      // It is still queued (pending retry), so the payload survives.
      const reenqueue = await queue.enqueue("evt-stall-requeue", { text: "user message" });
      expect(reenqueue.kind).not.toBe("failed");
      drain.dispose();
    });
  });

  it("holds ownership when an aborted pre-adoption dispatch has not exited", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall-fence", { text: "user message" }, { laneKey: "l1" });

      let dispatches = 0;
      let releaseFirst!: () => void;
      const firstDispatch = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          dispatches += 1;
          if (dispatches === 1) {
            // Abort-ignoring: still running after cancellation, but eventually exits.
            await firstDispatch;
            return;
          }
          await lifecycle.onAdopted();
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      clock += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);

      // Fence expired without the dispatch exiting: ownership is retained rather
      // than released into a concurrent re-dispatch. Wedged beats duplicated.
      expect(await queue.listClaims()).toHaveLength(1);
      const failed = await queue.listFailed?.();
      expect(failed ?? []).toHaveLength(0);

      // A second pump must not re-dispatch the still-running event.
      await drain.drainOnce();
      expect(dispatches).toBe(1);

      // Late quiescence must resume the watchdog-owned release; the lane cannot
      // remain wedged after the original callback finally exits.
      releaseFirst();
      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(0));
      expect(drain.activeLaneKeys()).toEqual(new Set());
      clock += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(dispatches).toBe(2);
      drain.dispose();
    });
  });

  it("fences the registered deferred participant until it terminally settles", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-deferred-fence", { text: "user message" }, { laneKey: "l1" });

      let dispatches = 0;
      let abandonFirst!: () => void | Promise<void>;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          dispatches += 1;
          if (dispatches === 1) {
            lifecycle.onDeferred();
            abandonFirst = lifecycle.onAbandoned;
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      await drain.drainOnce();
      await vi.waitFor(() => expect(dispatches).toBe(1));
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      clock += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);

      // The dispatcher promise returned "deferred", but its registered
      // participant is still live. A second pump must remain fenced.
      expect(await queue.listClaims()).toHaveLength(1);
      expect(await drain.drainOnce()).toEqual({ started: 0 });
      expect(dispatches).toBe(1);

      await abandonFirst();
      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(0));
      clock += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(dispatches).toBe(2);
      drain.dispose();
    });
  });

  it("refreshes a guillotined held claim past a short cross-process lease", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-held-lease", { text: "user message" }, { laneKey: "l1" });

      let releaseDispatch!: () => void;
      const dispatchGate = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const claimLeaseMs = 300;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        claimLeaseMs,
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: async () => {
          await dispatchGate;
        },
      });

      await drain.drainOnce();
      clock += 100;
      await vi.advanceTimersByTimeAsync(100);
      clock += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);

      // Stay held for several lease windows. The watchdog guillotine must not
      // stop refreshClaim, or another process can recover and double-dispatch.
      for (let index = 0; index < 6; index += 1) {
        clock += 100;
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(await queue.listClaims()).toHaveLength(1);
      expect(
        await queue.recoverStaleClaims({
          staleMs: claimLeaseMs,
          now: clock,
          shouldRecover: () => true,
        }),
      ).toBe(0);

      releaseDispatch();
      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(0));
      drain.dispose();
    });
  });

  it("watchdog only guillotines pre-adoption stalls with handler-timeout", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-stall", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: async () => {
          // Never adopt, never return — stall until watchdog.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      // Failed tombstone, not pending retry.
      const reenqueue = await queue.enqueue("evt-stall", { text: "x" });
      expect(reenqueue.kind).toBe("failed");
      if (reenqueue.kind === "failed") {
        expect(reenqueue.record.reason).toBe("handler-timeout");
      }
      drain.dispose();
    });
  });

  it("watchdog guillotines deferred phase (timer not cleared by deferral)", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-def-stall", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0 },
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.onDeferred();
          // Stay deferred without adoption — watchdog must still fire.
          await new Promise(() => {});
        },
      });

      await drain.drainOnce();
      expect(await queue.listClaims()).toHaveLength(1);
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await drain.waitForIdle();

      const reenqueue = await queue.enqueue("evt-def-stall", { text: "x" });
      expect(reenqueue.kind).toBe("failed");
      if (reenqueue.kind === "failed") {
        expect(reenqueue.record.reason).toBe("handler-timeout");
      }
      drain.dispose();
    });
  });

  it("watchdog does not kill healthy long turns after adoption", async () => {
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
      // Still only completed — not failed by watchdog.
      const status = await queue.enqueue("evt-long", { text: "x" });
      expect(status.kind).toBe("completed");
      settleResolve();
      await drain.waitForIdle();
      drain.dispose();
    });
  });

  it("releases a watchdog-held claim when the deferred participant is cancelled", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-guillotine-cancel", { text: "cancel me" }, { laneKey: "l1" });

      let cancelLifecycle: (() => Promise<void> | void) | undefined;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          cancelLifecycle = () => lifecycle.onCancelled?.();
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      // Watchdog fired and now awaits dispatch quiescence with the claim held.
      expect(await queue.listClaims()).toHaveLength(1);

      // Debounce-style cancellation after the guillotine must settle quiescence
      // so the fenced release completes; otherwise claim, lease, and lane stay
      // held forever.
      await cancelLifecycle?.();
      await drain.waitForIdle();
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.()).toHaveLength(0);
      drain.dispose();
    });
  });

  it("clears the pending stall settlement when release and dead-letter writes both exhaust", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-wedged-writes", { text: "wedged" }, { laneKey: "l1" });
      queue.release = async () => {
        throw new Error("persistent release failure");
      };
      queue.fail = async () => {
        throw new Error("persistent dead-letter failure");
      };

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          // Cooperative dispatch: exits on the watchdog abort so quiescence
          // resolves and the fenced settlement (release, then dead-letter
          // fallback) actually runs against the broken writes.
          await new Promise<void>((resolve) => {
            if (lifecycle.abortSignal.aborted) {
              resolve();
              return;
            }
            lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });

      await drain.drainOnce();
      clock += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      // Drain the bounded write-retry backoff for release, then the fallback
      // dead-letter attempts (both persistently failing).
      clock += 300_000;
      await vi.advanceTimersByTimeAsync(300_000);
      await drain.waitForIdle();

      // Wedged-but-owned: the claim is held, but the settlement must no longer
      // read as pending or the monitor rearms its idle wake and pumps forever.
      expect(await queue.listClaims()).toHaveLength(1);
      expect(drain.hasPendingStallSettlements?.()).toBe(false);
      drain.dispose();
    });
  });

  it("exports default adoption stall matching Telegram product default", () => {
    expect(DEFAULT_INGRESS_ADOPTION_STALL_MS).toBe(5 * 60 * 1000);
  });
});
