// Deferred ingress stall ownership tests stay separate from the core contract suite.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

type ChannelIngressDispatchLifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];

describe("channel ingress deferred stall ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("uses a distinct bounded watchdog after scheduler handoff", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-scheduler-owned", { text: "x" }, { laneKey: "l1" });
      let lifecycleRef: ChannelIngressDispatchLifecycle | undefined;
      let finishDispatch: (() => void) | undefined;
      const dispatchGate = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        deferredAdoptionStallTimeoutMs: 60_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycleRef = lifecycle;
          await dispatchGate;
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      clock += 4_999;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await queue.listClaims()).toHaveLength(1);
      expectDefined(finishDispatch, "dispatch gate")();
      await vi.advanceTimersByTimeAsync(0);

      clock += 59_999;
      await vi.advanceTimersByTimeAsync(59_999);

      expect(await queue.listClaims()).toHaveLength(1);
      const lifecycle = expectDefined(lifecycleRef, "scheduler-owned deferred lifecycle");
      await Promise.all([lifecycle.onAdopted(), lifecycle.onAdopted()]);
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await queue.enqueue("evt-scheduler-owned", { text: "x" })).kind).toBe("completed");
      drain.dispose();
    });
  });

  it("preserves the original claim-time deadline without an explicit deferred timeout", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-default-deadline", { text: "x" }, { laneKey: "l1" });
      let finishDispatch: (() => void) | undefined;
      const dispatchGate = new Promise<void>((resolve) => {
        finishDispatch = resolve;
      });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        dispatchClaimedEvent: async () => {
          await dispatchGate;
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      clock += 4_999;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(await queue.listClaims()).toHaveLength(1);
      expectDefined(finishDispatch, "default deadline dispatch gate")();
      await vi.advanceTimersByTimeAsync(0);

      clock += 1;
      await vi.advanceTimersByTimeAsync(1);
      await drain.waitForIdle();

      const result = await queue.enqueue("evt-default-deadline", { text: "x" });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.record.reason).toBe("handler-timeout");
      }
      drain.dispose();
    });
  });

  it("dead-letters a deferred claim when its scheduler never terminates", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const logs: string[] = [];
      let lostLifecycle: ChannelIngressDispatchLifecycle | undefined;
      const dispatched: string[] = [];
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-lost-scheduler", { text: "x" }, { laneKey: "l1" });

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        deferredAdoptionStallTimeoutMs: 60_000,
        onLog: (message) => logs.push(message),
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          if (event.id === "evt-lost-scheduler") {
            lostLifecycle = lifecycle;
            return { kind: "deferred" };
          }
          return { kind: "completed" };
        },
      });

      await drain.drainOnce();
      clock += 59_999;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(await queue.listClaims()).toHaveLength(1);

      clock += 1;
      await vi.advanceTimersByTimeAsync(1);
      await drain.waitForIdle();

      const lifecycle = expectDefined(lostLifecycle, "lost deferred lifecycle");
      expect(lifecycle.abortSignal.aborted).toBe(true);
      await expect(lifecycle.onAdopted()).rejects.toMatchObject({ code: "guillotined" });
      const reenqueue = await queue.enqueue("evt-lost-scheduler", { text: "x" });
      expect(reenqueue.kind).toBe("failed");
      if (reenqueue.kind === "failed") {
        expect(reenqueue.record.reason).toBe("handler-timeout");
      }
      expect(logs.some((message) => message.includes("deferred claim→adoption stalled"))).toBe(
        true,
      );
      await queue.enqueue("evt-successor", { text: "y" }, { laneKey: "l1" });
      expect((await drain.drainOnce()).started).toBe(1);
      await drain.waitForIdle();
      expect(dispatched).toEqual(["evt-lost-scheduler", "evt-successor"]);
      drain.dispose();
    });
  });

  it("cancels the deferred watchdog after abandonment", async () => {
    await withTempState(async (stateDir) => {
      let clock = 30_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-abandoned", { text: "x" }, { laneKey: "l1" });
      let lifecycleRef: ChannelIngressDispatchLifecycle | undefined;

      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 5_000,
        deferredAdoptionStallTimeoutMs: 60_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycleRef = lifecycle;
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      const lifecycle = expectDefined(lifecycleRef, "abandoned deferred lifecycle");
      await Promise.all([lifecycle.onAbandoned(), lifecycle.onAbandoned()]);
      clock += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await queue.listClaims()).toEqual([]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "evt-abandoned",
      ]);
      drain.dispose();
    });
  });
});
