import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { fanInChannelIngressLifecycles } from "../../plugin-sdk/channel-ingress-runtime.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";
import { prepareDiscardIngressClaims } from "./ingress-processing-handoff.js";

describe("terminal ingress Stop ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fences every merged source before reentrant abandonment", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const lifecycles: ChannelIngressDispatchLifecycle[] = [];
      for (const id of ["first", "second"]) {
        await queue.enqueue(id, { text: id }, { laneKey: id });
      }
      const drain = createChannelIngressDrain({
        queue,
        dispatchClaimedEvent: (_event, lifecycle) => {
          lifecycles.push(lifecycle);
          return { kind: "deferred" };
        },
      });
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        const merged = expectDefined(
          fanInChannelIngressLifecycles(lifecycles).lifecycle,
          "merged ingress sources",
        );
        const abandoned = createDeferred();
        merged.abortSignal.addEventListener("abort", () => {
          void merged.onAbandoned().then(() => abandoned.resolve());
        });
        prepareDiscardIngressClaims([merged.abortSignal, lifecycles[0]!.abortSignal])();
        await abandoned.promise;
        await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
        expect(await queue.listPending()).toEqual([]);
        for (const id of ["first", "second"]) {
          expect((await queue.enqueue(id, { text: "duplicate" })).kind).toBe("completed");
        }
        await expect(merged.onAdopted()).rejects.toMatchObject({ code: "superseded" });
      } finally {
        drain.dispose();
      }
    });
  });

  it.each(["succeeds", "fails"] as const)(
    "stays terminal when adoption finalization later %s",
    async (outcome) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("finalizing", { text: "hello" });
        const finalizing = createDeferred<ChannelIngressDispatchLifecycle>();
        const release = createDeferred();
        const drain = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycle.onAdoptionFinalizing();
            finalizing.resolve(lifecycle);
            await release.promise;
            if (outcome === "fails") {
              throw new Error("dispatch dedupe finalization failed");
            }
            await lifecycle.onAdopted();
          },
        });
        try {
          await drain.drainOnce();
          const lifecycle = await finalizing.promise;
          prepareDiscardIngressClaims([lifecycle.abortSignal])();
          release.resolve();
          await drain.waitForIdle();
          await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
          expect(await queue.listPending()).toEqual([]);
          expect((await queue.enqueue("finalizing", { text: "duplicate" })).kind).toBe("completed");
          await expect(lifecycle.onAdopted()).rejects.toMatchObject({ code: "superseded" });
        } finally {
          release.resolve();
          drain.dispose();
        }
      });
    },
  );

  it("preserves a release already owned by an in-progress writer", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("releasing", { text: "hello" });
      const captured = createDeferred<ChannelIngressDispatchLifecycle>();
      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      let lifecycle: ChannelIngressDispatchLifecycle;
      const drain = createChannelIngressDrain({
        queue: {
          ...queue,
          release: async (...args) => {
            // A synchronous callback from inside the writer must also see its ownership.
            prepareDiscardIngressClaims([lifecycle.abortSignal])();
            writerEntered.resolve();
            await releaseWriter.promise;
            return queue.release(...args);
          },
        },
        dispatchClaimedEvent: (_event, owner) => {
          captured.resolve(owner);
          return { kind: "deferred" };
        },
      });
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        lifecycle = await captured.promise;
        const release = lifecycle.onAbandoned();
        await writerEntered.promise;
        prepareDiscardIngressClaims([lifecycle.abortSignal])();
        expect(lifecycle.abortSignal.aborted).toBe(false);
        releaseWriter.resolve();
        await release;
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([
          { id: "releasing", attempts: 1, lastError: "turn-abandoned" },
        ]);
      } finally {
        releaseWriter.resolve();
        drain.dispose();
      }
    });
  });

  it("leaves a disposed claim available for the replacement drain", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("restart", { text: "hello" });
      const captured = createDeferred<ChannelIngressDispatchLifecycle>();
      const drain = createChannelIngressDrain({
        queue,
        dispatchClaimedEvent: (_event, lifecycle) => {
          captured.resolve(lifecycle);
          return { kind: "deferred" };
        },
      });
      await drain.drainOnce();
      await drain.waitForIdle();
      const lifecycle = await captured.promise;
      drain.dispose();
      prepareDiscardIngressClaims([lifecycle.abortSignal])();
      await lifecycle.onCancelled?.();
      expect(await queue.listPending()).toMatchObject([{ id: "restart", attempts: 0 }]);
      const dispatch = vi.fn(async (_event: unknown, owner: ChannelIngressDispatchLifecycle) => {
        await owner.onAdopted();
      });
      const replacement = createChannelIngressDrain({ queue, dispatchClaimedEvent: dispatch });
      try {
        await replacement.drainOnce();
        await replacement.waitForIdle();
        expect(dispatch).toHaveBeenCalledOnce();
        expect((await queue.enqueue("restart", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        replacement.dispose();
      }
    });
  });

  it.each(["transient", "exhausted"] as const)(
    "keeps Stop terminal through %s tombstone failure",
    async (failure) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("stopped", { text: "hello" });
        const captured = createDeferred<ChannelIngressDispatchLifecycle>();
        const logs: string[] = [];
        let writes = 0;
        const drain = createChannelIngressDrain({
          queue: {
            ...queue,
            complete: async (...args) => {
              writes += 1;
              if (failure === "exhausted" || writes === 1) {
                throw new Error("database write unavailable");
              }
              return queue.complete(...args);
            },
          },
          onLog: (message) => logs.push(message),
          dispatchClaimedEvent: (_event, lifecycle) => {
            captured.resolve(lifecycle);
            return { kind: "deferred" };
          },
        });
        try {
          await drain.drainOnce();
          await drain.waitForIdle();
          const lifecycle = await captured.promise;
          prepareDiscardIngressClaims([lifecycle.abortSignal])();
          await lifecycle.onAbandoned();
          // The seven retry backoffs total 127 seconds before the final write.
          await vi.advanceTimersByTimeAsync(130_000);
          expect(await queue.listPending()).toEqual([]);
          expect(await drain.drainOnce()).toEqual({ started: 0 });
          await expect(lifecycle.onAdopted()).rejects.toMatchObject({ code: "superseded" });
          if (failure === "transient") {
            expect(await queue.listClaims()).toEqual([]);
            expect((await queue.enqueue("stopped", { text: "duplicate" })).kind).toBe("completed");
          } else {
            expect(await queue.listClaims()).toHaveLength(1);
            expect(logs).toContainEqual(
              expect.stringContaining("failed to tombstone superseded event stopped"),
            );
          }
        } finally {
          drain.dispose();
        }
      });
    },
  );
});
