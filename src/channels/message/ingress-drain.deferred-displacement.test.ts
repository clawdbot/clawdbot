// Regression tests: a deferred claim displaced from the per-lane map by a later
// same-lane claim (deferredClaimDoesNotBlockLane) must remain supersedable,
// abortable on dispose, and awaited by waitForIdle.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain, isIngressAdoptionLostError } from "./ingress-drain.js";

// Module-private in ingress-drain.ts; derive from the factory signature.
type ChannelIngressDispatchLifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];
import { createChannelIngressQueue } from "./ingress-queue.js";

type Payload = { text: string };

function createTestIngressQueue(stateDir: string) {
  return createChannelIngressQueue<Payload>({
    channelId: "test",
    accountId: "a",
    stateDir,
  });
}

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-drain-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
});

describe("channel ingress drain deferred displacement", () => {
  it("displaced deferred claims stay supersedable after a later same-lane claim", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-a", { text: "a" }, { laneKey: "l1" });
      await queue.enqueue("evt-b", { text: "b" }, { laneKey: "l1" });

      const dispatched: string[] = [];
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredClaimDoesNotBlockLane: true,
        shouldSupersedePending: (candidate) => candidate.id === "evt-c",
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          lifecycles.set(event.id, lifecycle);
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => {
        expect(dispatched).toEqual(["evt-a"]);
      });
      // evt-b claims the lane while evt-a is deferred, displacing evt-a from the
      // per-lane map. evt-a's claim must remain supersedable anyway.
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => {
        expect(dispatched).toEqual(["evt-a", "evt-b"]);
      });
      expect(await queue.listClaims()).toHaveLength(2);

      // evt-c supersedes BOTH pre-adoption claims: displaced evt-a and evt-b.
      await queue.enqueue("evt-c", { text: "c" }, { laneKey: "l1" });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => {
        expect(dispatched).toEqual(["evt-a", "evt-b", "evt-c"]);
      });
      expect(lifecycles.get("evt-a")?.abortSignal.aborted).toBe(true);
      expect(lifecycles.get("evt-b")?.abortSignal.aborted).toBe(true);
      await drain.waitForIdle();
      // Only evt-c's claim remains held; evt-a/evt-b were tombstoned, not released.
      expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["evt-c"]);

      // Late adoption of a superseded claim is a closed error, never a settle.
      const lateAdopt = await Promise.resolve(
        expectDefined(lifecycles.get("evt-a"), "evt-a lifecycle").onAdopted(),
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(isIngressAdoptionLostError(lateAdopt) && lateAdopt.code).toBe("superseded");

      await expectDefined(lifecycles.get("evt-c"), "evt-c lifecycle").onAdopted();
      await drain.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(0);
      drain.dispose();
    });
  });

  it("dispose aborts displaced deferred claims and waitForIdle awaits them", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-a", { text: "a" }, { laneKey: "l1" });
      await queue.enqueue("evt-b", { text: "b" }, { laneKey: "l1" });

      const dispatched: string[] = [];
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      let evtATaskSettled = false;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredClaimDoesNotBlockLane: true,
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatched.push(event.id);
          lifecycles.set(event.id, lifecycle);
          if (event.id === "evt-a") {
            // Hold the dispatch open until aborted, like the Telegram adapter
            // awaiting a buffered album participant's terminal result: defer
            // first, then wait.
            lifecycle.onDeferred();
            await new Promise<void>((resolve) => {
              if (lifecycle.abortSignal.aborted) {
                resolve();
                return;
              }
              lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            }).then(() => {
              evtATaskSettled = true;
            });
          }
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => {
        expect(dispatched).toEqual(["evt-a"]);
      });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => {
        expect(dispatched).toEqual(["evt-a", "evt-b"]);
      });

      // evt-a is displaced but still holding its claim: dispose must abort it,
      // and waitForIdle must await its task.
      const idle = drain.waitForIdle();
      drain.dispose();
      await idle;
      expect(lifecycles.get("evt-a")?.abortSignal.aborted).toBe(true);
      expect(lifecycles.get("evt-b")?.abortSignal.aborted).toBe(true);
      expect(evtATaskSettled).toBe(true);
    });
  });
});
