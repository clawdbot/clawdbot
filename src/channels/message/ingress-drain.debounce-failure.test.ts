// Shared debounce-to-drain composition regression for pre-admission failures.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain, DEFAULT_INGRESS_ADOPTION_STALL_MS } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

type ChannelIngressDispatchLifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];

describe("channel ingress drain debounce failures", () => {
  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("retries a pre-admission failure without waiting for the watchdog", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "debounced-retry",
        { text: "retry me" },
        {
          laneKey: "shared",
          receivedAt: clock,
        },
      );
      const sessionError = new Error("Session changed while starting work. Retry.");
      const reportedErrors: unknown[] = [];
      let attempt = 0;
      const debouncer = createInboundDebouncer<{ lifecycle: ChannelIngressDispatchLifecycle }>({
        debounceMs: 0,
        buildKey: () => "shared",
        onFlush: (entries, createFlush) =>
          createFlush({
            lifecycle: entries[0]?.lifecycle,
            dispatch: async (lifecycle) => {
              attempt += 1;
              if (attempt === 1) {
                throw sessionError;
              }
              await lifecycle.onAdopted();
            },
          }),
        onError: (error) => reportedErrors.push(error),
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: DEFAULT_INGRESS_ADOPTION_STALL_MS,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await debouncer.enqueue({ lifecycle });
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        { id: "debounced-retry", attempts: 1, lastError: sessionError.message },
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);

      clock += 1_000;
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      await debouncer.drain();

      expect(attempt).toBe(2);
      expect(reportedErrors).toEqual([sessionError]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(await queue.enqueue("debounced-retry", { text: "retry me" })).toMatchObject({
        kind: "completed",
      });
      drain.dispose();
    });
  });

  it("keeps watchdog recovery after retry settlement fails", async () => {
    vi.useFakeTimers();
    await withTempState(async (stateDir) => {
      let clock = 10_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue(
        "debounced-settlement-failure",
        { text: "retry me" },
        { laneKey: "shared", receivedAt: clock },
      );
      queue.release = async () => {
        throw new Error("persistent release failure");
      };

      const sessionError = new Error("Session changed while starting work. Retry.");
      const debouncer = createInboundDebouncer<{ lifecycle: ChannelIngressDispatchLifecycle }>({
        debounceMs: 0,
        buildKey: () => "shared",
        onFlush: (entries, createFlush) =>
          createFlush({
            lifecycle: entries[0]?.lifecycle,
            dispatch: async () => {
              throw sessionError;
            },
          }),
        onError: () => undefined,
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        adoptionStallTimeoutMs: 200_000,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          await debouncer.enqueue({ lifecycle });
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.advanceTimersByTimeAsync(127_000);
      clock += 127_000;
      await drain.waitForIdle();

      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
        "debounced-settlement-failure",
      ]);
      expect(drain.activeLaneKeys().has("shared")).toBe(true);

      clock += 73_000;
      await vi.advanceTimersByTimeAsync(73_000);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "debounced-settlement-failure", reason: "handler-timeout" },
      ]);
      expect(drain.activeLaneKeys().has("shared")).toBe(false);
      drain.dispose();
    });
  });
});
