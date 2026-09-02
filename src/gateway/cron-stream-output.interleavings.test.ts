import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import {
  createWatchers,
  exitResult,
  fakeSupervisor,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

describe("cron stream output", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("serialized output interleavings", () => {
    it("drops and counts an open batch when disable wins, then freezes after stop", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      const lateOutput = fake.inputs[0]?.onStdout;
      lateOutput?.("open batch\n");
      await settle();
      await watchers.stop("stream-job", "disabled");

      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
        droppedBatches: 1,
        coalescedBatches: 0,
      });
      expect(fireBatch).not.toHaveBeenCalled();
      const counterWrites = () =>
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined);
      expect(counterWrites()).toHaveLength(1);

      lateOutput?.("late batch\n");
      await vi.runAllTimersAsync();
      await settle();
      expect(counterWrites()).toHaveLength(1);
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
    });

    it("does not count unmatched partial or discarded oversized input as a batch", async () => {
      const fake = fakeSupervisor();
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      const unmatched = job({
        id: "unmatched-partial",
        schedule: {
          kind: "stream",
          command: ["source"],
          mode: "match",
          match: "^keep$",
          maxBatchBytes: 1_024,
        },
      });
      const oversized = job({
        id: "discarded-oversized",
        schedule: {
          kind: "stream",
          command: ["source"],
          mode: "match",
          match: "\\[truncated\\]$",
          maxBatchBytes: 1_024,
        },
      });
      await watchers.start(unmatched);
      await watchers.start(oversized);
      fake.inputs[0]?.onStdout?.("ignore");
      fake.inputs[1]?.onStdout?.("x".repeat(600));
      await settle();
      fake.inputs[1]?.onStdout?.("x".repeat(600));
      await settle();

      await watchers.stop(unmatched.id, "disabled");
      await watchers.stop(oversized.id, "disabled");

      expect(watchers.inspect(unmatched.id)?.droppedBatches).toBe(0);
      expect(watchers.inspect(oversized.id)?.droppedBatches).toBe(0);
    });

    it("carries final counters into a replacement created from a stale snapshot", async () => {
      const fake = fakeSupervisor();
      const updateState = vi.fn(async () => {});
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      const staleJob = job();
      await watchers.start(staleJob);
      fake.inputs[0]?.onStdout?.("first\n");
      await settle();
      await watchers.stop(staleJob.id, "removed");

      await watchers.start(staleJob);
      fake.inputs[1]?.onStdout?.("second\n");
      await settle();
      await watchers.stop(staleJob.id, "disabled");

      expect(watchers.inspect(staleJob.id)?.droppedBatches).toBe(2);
      expect(updateState).toHaveBeenCalledWith(
        staleJob.id,
        expect.objectContaining({ streamDroppedBatches: 2 }),
        expect.any(String),
        expect.any(String),
      );
    });

    it("ignores obsolete process output during backoff and after replacement", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        retryBackoffMs: [10],
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      const obsoleteOutput = fake.inputs[0]?.onStdout;
      fake.exits[0]?.(exitResult());
      await settle();
      expect(watchers.inspect("stream-job")?.state).toBe("backoff");

      obsoleteOutput?.("late during backoff\n");
      await settle();
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

      await vi.advanceTimersByTimeAsync(10);
      await settle();
      expect(fake.spawn).toHaveBeenCalledTimes(2);

      obsoleteOutput?.("late after replacement\n");
      await settle();

      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);
      expect(
        updateState.mock.calls.some(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toBe(false);
      await watchers.stopAll("shutdown");
    });

    it("retains a cadence-delayed batch across source restart backoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 100,
        retryBackoffMs: [200],
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      const initialOwner = watchers.inspect("stream-job");
      expect(initialOwner?.sourceIdentity).toBe("source:stream-job");
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.exits[0]?.(exitResult());
      await settle();

      await vi.advanceTimersByTimeAsync(50);
      expect(fireBatch).toHaveBeenCalledTimes(1);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "backoff",
        droppedBatches: 0,
      });

      await vi.advanceTimersByTimeAsync(150);
      await settle();
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        generation: expect.any(Number),
        sourceIdentity: initialOwner?.sourceIdentity,
      });
      expect(watchers.inspect("stream-job")?.generation).toBeGreaterThan(
        initialOwner?.generation ?? 0,
      );
      expect(fireBatch).toHaveBeenLastCalledWith(
        expect.any(Object),
        "pending",
        expect.any(String),
        initialOwner?.sourceIdentity,
      );
      await watchers.stopAll("shutdown");
    });

    it("counts a pending batch before terminal restart exhaustion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const updateState = vi.fn(async () => {});
      const recordFailure = vi.fn(async () => {});
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 100,
        updateState,
        recordFailure,
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ state: { lastRunAtMs: 1_000, streamConsecutiveFailures: 4 } }));
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.exits[0]?.(exitResult());
      await settle();

      expect(fireBatch).not.toHaveBeenCalled();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
        consecutiveFailures: 5,
      });
      expect(recordFailure).toHaveBeenCalledOnce();
    });

    it("honors a synchronous stop fence in a pending-fire operation already queued first", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 100,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();

      vi.advanceTimersByTime(50);
      await watchers.stop("stream-job", "disabled");

      expect(fireBatch).toHaveBeenCalledTimes(1);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
      });
    });

    it("drains output accepted behind a slow owner write before entering backoff", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      let releaseCounter!: () => void;
      const counter = new Promise<void>((resolve) => {
        releaseCounter = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamCoalescedBatches === 1) {
          await counter;
        }
      });
      const fireBatch = vi
        .fn()
        .mockImplementationOnce(async () => {
          await payload;
          return "fired" as const;
        })
        .mockResolvedValue("fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        retryBackoffMs: [1],
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.inputs[0]?.onStdout?.("second\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      expect(updateState).toHaveBeenCalledWith(
        "stream-job",
        expect.objectContaining({ streamCoalescedBatches: 1 }),
        expect.any(String),
        expect.any(String),
      );

      fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
      fake.exits[0]?.(exitResult());
      releaseCounter();
      await settle();
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

      releasePayload();
      await settle();
      await vi.advanceTimersByTimeAsync(2);
      expect(fireBatch).toHaveBeenLastCalledWith(
        expect.any(Object),
        "second\naccepted-before-exit",
        expect.any(String),
        expect.any(String),
      );
      await watchers.stopAll("shutdown");
    });

    it("lets a stop requested during exit draining own teardown without counting failure", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      let markDrainEntered!: () => void;
      const drainEntered = new Promise<void>((resolve) => {
        markDrainEntered = resolve;
      });
      let releaseDrain!: () => void;
      const drain = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamCoalescedBatches === 2) {
          markDrainEntered();
          await drain;
        }
      });
      const recordFailure = vi.fn(async () => {});
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        updateState,
        recordFailure,
        fireBatch: vi.fn(async () => {
          await payload;
          return "fired" as const;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ state: { streamConsecutiveFailures: 4 } }));
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.inputs[0]?.onStdout?.("second\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();

      fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
      fake.exits[0]?.(exitResult());
      await drainEntered;
      const stopping = watchers.stop("stream-job", "disabled");
      releasePayload();
      releaseDrain();
      await settle();
      await stopping;

      expect(recordFailure).not.toHaveBeenCalled();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        consecutiveFailures: 4,
      });
    });

    it("ignores a late batch after removal without moving counters", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      const lateOutput = fake.inputs[0]?.onStdout;
      await watchers.stop("stream-job", "removed");
      const counterWrites = updateState.mock.calls.filter(
        ([, patch]) => patch.streamDroppedBatches !== undefined,
      ).length;

      lateOutput?.("late\n");
      await vi.runAllTimersAsync();
      await settle();

      expect(watchers.inspect("stream-job")).toBeUndefined();
      expect(fireBatch).not.toHaveBeenCalled();
      expect(
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toHaveLength(counterWrites);
    });

    it("bounds raw output while a serialized counter write is slow", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      let releaseCounter!: () => void;
      const counter = new Promise<void>((resolve) => {
        releaseCounter = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamCoalescedBatches === 1) {
          await counter;
        }
      });
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => {
          await payload;
          return "fired" as const;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(
        job({
          schedule: {
            kind: "stream",
            command: ["source"],
            batchMs: 50,
            maxBatchBytes: 1_024,
          },
        }),
      );
      fake.inputs[0]?.onStdout?.("first\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      fake.inputs[0]?.onStdout?.("second\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      expect(updateState).toHaveBeenCalledWith(
        "stream-job",
        expect.objectContaining({ streamCoalescedBatches: 1 }),
        expect.any(String),
        expect.any(String),
      );

      for (let index = 0; index < 1_000; index += 1) {
        fake.inputs[0]?.onStdout?.(`${"x".repeat(100)}\n`);
      }
      expect(watchers.inspect("stream-job")).toMatchObject({
        // Raw intake is bounded at 4x the batch cap between drains.
        bufferedOutputBytes: 4_096,
        bufferedOutputSegments: 1,
      });

      releaseCounter();
      releasePayload();
      await vi.advanceTimersByTimeAsync(100);
      await settle();
      await watchers.stopAll("shutdown");
    });

    it("bounds stop while a payload remains in flight and freezes its counter", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const watchers = createWatchers({
        getProcessSupervisor: () => fake.supervisor,
        minIntervalMs: 1,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => {
          await payload;
          return "fired" as const;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("in flight\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);

      const stopping = watchers.stop("stream-job", "disabled");
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
      });
      const counterWrites = updateState.mock.calls.filter(
        ([, patch]) => patch.streamDroppedBatches !== undefined,
      ).length;

      releasePayload();
      await settle();
      expect(
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toHaveLength(counterWrites);
    });
  });
});
