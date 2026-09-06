import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { compactWithSafetyTimeout } from "../../agents/embedded-agent-runner/compaction-safety-timeout.js";
import { fanInChannelIngressLifecycles } from "../../plugin-sdk/channel-ingress-runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";
import {
  awaitIngressProcessing,
  captureIngressProcessingDeadline,
  withIngressProcessingPhase,
  withIngressProcessingScope,
} from "./ingress-processing-handoff.js";

describe("ingress processing timeout ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("holds only the fanned-in claims past ingress expiry and ignores late heartbeats", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      for (const id of ["first", "second", "unstarted"]) {
        await queue.enqueue(id, { text: id }, { laneKey: id });
      }
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 1_000,
        dispatchClaimedEvent: (event, lifecycle) => {
          lifecycles.set(event.id, lifecycle);
          return { kind: "deferred" };
        },
      });
      const release = createDeferred();
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        const { lifecycle } = fanInChannelIngressLifecycles([
          lifecycles.get("first"),
          lifecycles.get("second"),
        ]);
        if (!lifecycle) {
          throw new Error("Expected both claimed sources");
        }
        const before = await queue.listClaims();
        const processing = withIngressProcessingScope(lifecycle.abortSignal, async () => {
          await withIngressProcessingPhase(
            { kind: "compaction", timeoutMs: 5_000, abortSignal: lifecycle.abortSignal },
            () => release.promise,
          );
          await lifecycle.onAdopted();
        });
        await vi.advanceTimersByTimeAsync(900);
        lifecycle.onDeferredHeartbeat?.();
        await vi.advanceTimersByTimeAsync(1_100);

        const held = await queue.listClaims();
        expect(held.map((claim) => claim.id).toSorted()).toEqual(["first", "second"]);
        for (const claim of held) {
          expect(claim.claim.token).toBe(
            before.find((entry) => entry.id === claim.id)?.claim.token,
          );
          expect(claim.attempts).toBe(0);
        }
        expect(await queue.listPending()).toMatchObject([
          { id: "unstarted", attempts: 1, lastError: expect.stringContaining("handler-timeout") },
        ]);
        release.resolve();
        await processing;
        expect(await queue.listClaims()).toEqual([]);
        expect((await queue.enqueue("first", { text: "redelivery" })).kind).toBe("completed");
        expect((await queue.enqueue("second", { text: "redelivery" })).kind).toBe("completed");
      } finally {
        release.resolve();
        drain.dispose();
      }
    });
  });

  it("keeps the processing deadline through post-compaction admission work", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("cleanup-stall", { text: "hello" });
      const entered = createDeferred();
      const release = createDeferred();
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: async (_event, lifecycle) =>
          withIngressProcessingScope(lifecycle.abortSignal, async () => {
            await withIngressProcessingPhase(
              { kind: "compaction", timeoutMs: 500 },
              async () => {},
            );
            entered.resolve();
            await awaitIngressProcessing(() => release.promise);
            await lifecycle.onAdopted();
          }),
      });
      try {
        await drain.drainOnce();
        await entered.promise;
        await vi.advanceTimersByTimeAsync(200);
        expect(await queue.listClaims()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(301);
        await drain.waitForIdle();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([
          {
            id: "cleanup-stall",
            attempts: 1,
            lastError: expect.stringContaining("Compaction timed out"),
          },
        ]);
      } finally {
        release.resolve();
        drain.dispose();
      }
    });
  });

  it("does not let a completed memory attempt reset its successor's deadline", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("successor", { text: "hello" });
      const entered = createDeferred();
      const release = createDeferred();
      let memory: ReturnType<typeof captureIngressProcessingDeadline>;
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: (_event, lifecycle) =>
          withIngressProcessingScope(lifecycle.abortSignal, async () => {
            await withIngressProcessingPhase({ kind: "memory", timeoutMs: 5_000 }, async () => {
              memory = captureIngressProcessingDeadline("memory");
            });
            await withIngressProcessingPhase({ kind: "compaction", timeoutMs: 500 }, async () => {
              entered.resolve();
              await release.promise;
            });
            await lifecycle.onAdopted();
          }),
      });
      try {
        await drain.drainOnce();
        await entered.promise;
        await vi.advanceTimersByTimeAsync(400);
        memory?.reset();
        memory?.update({ kind: "unlimited" });
        memory?.close();
        await vi.advanceTimersByTimeAsync(101);
        await drain.waitForIdle();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([
          {
            id: "successor",
            attempts: 1,
            lastError: expect.stringContaining("Compaction timed out"),
          },
        ]);
      } finally {
        release.resolve();
        drain.dispose();
      }
    });
  });

  it("gives an armed compactor its full window after preparation", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("prepared", { text: "hello" });
      const preparation = createDeferred();
      const engineStarted = createDeferred();
      const release = createDeferred();
      const drain = createChannelIngressDrain({
        queue,
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: (_event, lifecycle) =>
          withIngressProcessingScope(lifecycle.abortSignal, async () => {
            await withIngressProcessingPhase(
              { kind: "compaction", timeoutMs: 500 },
              async (signal) => {
                await preparation.promise;
                await compactWithSafetyTimeout(
                  () => {
                    engineStarted.resolve();
                    return release.promise;
                  },
                  500,
                  { abortSignal: signal },
                );
              },
            );
            await lifecycle.onAdopted();
          }),
      });
      try {
        await drain.drainOnce();
        await vi.advanceTimersByTimeAsync(400);
        preparation.resolve();
        await engineStarted.promise;
        await vi.advanceTimersByTimeAsync(200);
        expect(await queue.listClaims()).toHaveLength(1);
        expect(await queue.listPending()).toEqual([]);
        release.resolve();
        await drain.waitForIdle();
        expect((await queue.enqueue("prepared", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        preparation.resolve();
        release.resolve();
        drain.dispose();
      }
    });
  });
});
