import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { ChannelIngressDispatchLifecycle } from "./ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain restart-recovery tombstone", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    { reclaimed: false, terminal: false },
    { reclaimed: false, terminal: true },
    { reclaimed: true, terminal: false },
    { reclaimed: true, terminal: true },
  ])(
    "reports settlement only after the claim write succeeds: %j",
    async ({ reclaimed, terminal }) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
        await queue.enqueue("evt-head", { text: "question" }, { laneKey: "dm" });
        let lifecycle: ChannelIngressDispatchLifecycle | undefined;
        const logs: string[] = [];
        const drain = createChannelIngressDrain({
          queue,
          onLog: (message) => logs.push(message),
          dispatchClaimedEvent: (_event, current) => {
            lifecycle = current;
            return { kind: "deferred" };
          },
        });
        try {
          await drain.drainOnce();
          await vi.waitFor(() => expect(lifecycle).toBeDefined());
          if (reclaimed) {
            expect(await queue.recoverStaleClaims({ staleMs: 0, now: 10_001 })).toBe(1);
          }
          await expectDefined(
            expectDefined(lifecycle, "deferred lifecycle").onFailed,
            "failure callback",
          )(
            Object.assign(
              new Error("dispatch failure"),
              terminal ? { code: "SESSION_RESTART_RECOVERY_TOMBSTONE" } : {},
            ),
          );
          expect(await queue.listFailed?.()).toHaveLength(!reclaimed && terminal ? 1 : 0);
          expect(await queue.listPending()).toHaveLength(!reclaimed && terminal ? 0 : 1);
          expect(
            logs.some((message) =>
              message.includes(terminal ? "; dead-lettered" : "; keeping for retry:"),
            ),
          ).toBe(!reclaimed);
        } finally {
          drain.dispose();
        }
      });
    },
  );

  it.each([false, true])(
    "retains the failed head and drains its follower without replay (prior retry: %s)",
    async (priorRetry) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
        await queue.enqueue("evt-head", { text: "question" }, { laneKey: "dm", receivedAt: 1 });
        await queue.enqueue("evt-follower", { text: "next" }, { laneKey: "dm", receivedAt: 2 });
        if (priorRetry) {
          const claim = expectDefined(
            await queue.claim("evt-head", { ownerId: "previous-worker" }),
            "previous claim",
          );
          await queue.release(claim, { lastError: "temporary failure", releasedAt: 10 });
        }
        const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => 10_000,
          deferredLaneOccupancy: "release",
          dispatchClaimedEvent: async (event, lifecycle) => {
            lifecycles.set(event.id, lifecycle);
            return { kind: "deferred" };
          },
        });
        try {
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await vi.waitFor(() => expect([...lifecycles.keys()]).toEqual(["evt-head"]));
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            { id: "evt-follower", attempts: 0 },
          ]);
          const error = new Error("reply admission refused", {
            cause: Object.assign(new Error("terminal generation"), {
              code: "SESSION_RESTART_RECOVERY_TOMBSTONE",
            }),
          });
          await expectDefined(
            expectDefined(lifecycles.get("evt-head"), "head lifecycle").onFailed,
            "head failure lifecycle",
          )(error);
          const expectedFailed = [
            {
              id: "evt-head",
              channelId: "test",
              accountId: "a",
              queueName: JSON.stringify(["test", "a"]),
              laneKey: "dm",
              payload: { text: "question" },
              receivedAt: 1,
              updatedAt: 10_000,
              attempts: priorRetry ? 1 : 0,
              ...(priorRetry ? { lastAttemptAt: 10 } : {}),
              failedAt: 10_000,
              reason: "restart-recovery-tombstone",
              message:
                "reply admission refused | terminal generation | SESSION_RESTART_RECOVERY_TOMBSTONE",
            },
          ];
          expect(await queue.listFailed?.({ limit: "all" })).toEqual(expectedFailed);
          expect(await drain.drainOnce()).toEqual({ started: 1 });
          await vi.waitFor(() =>
            expect([...lifecycles.keys()]).toEqual(["evt-head", "evt-follower"]),
          );
          await expectDefined(lifecycles.get("evt-follower"), "follower lifecycle").onAdopted();
          expect(await queue.listPending({ limit: "all" })).toEqual([]);
          expect(await queue.listClaims()).toEqual([]);
          drain.dispose();
          closeOpenClawStateDatabaseForTest();

          const reopened = createTestIngressQueue(stateDir, { now: () => 20_000 });
          const dispatchAfterRestart = vi.fn(async () => {});
          const restarted = createChannelIngressDrain({
            queue: reopened,
            dispatchClaimedEvent: dispatchAfterRestart,
          });
          try {
            expect(await restarted.recoverStaleClaims()).toBe(0);
            expect(await restarted.drainOnce()).toEqual({ started: 0 });
            expect(await reopened.enqueue("evt-head", { text: "question" })).toMatchObject({
              kind: "failed",
              duplicate: true,
            });
            expect(await reopened.enqueue("evt-follower", { text: "next" })).toMatchObject({
              kind: "completed",
              duplicate: true,
            });
            expect(await restarted.drainOnce()).toEqual({ started: 0 });
            expect(dispatchAfterRestart).not.toHaveBeenCalled();
            expect(await reopened.listFailed?.({ limit: "all" })).toEqual(expectedFailed);
          } finally {
            restarted.dispose();
          }
        } finally {
          drain.dispose();
        }
      });
    },
  );
});
