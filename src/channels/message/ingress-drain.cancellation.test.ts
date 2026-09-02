import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanInChannelIngressLifecycles } from "../../plugin-sdk/channel-ingress-runtime.js";
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

function withoutCancellation(
  lifecycle: ChannelIngressDispatchLifecycle,
): Omit<ChannelIngressDispatchLifecycle, "onCancelled"> {
  const { onCancelled: _onCancelled, ...legacy } = lifecycle;
  return legacy;
}

describe("channel ingress drain cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("cancels unadopted work without changing its retry facts", async () => {
    await withTempState(async (stateDir) => {
      let clock = 100;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-cancel", { text: "x" }, { laneKey: "l1", receivedAt: 1 });
      const failedClaim = await queue.claim("evt-cancel", { ownerId: "failed-owner" });
      expect(failedClaim).not.toBeNull();
      if (!failedClaim) {
        return;
      }
      await queue.release(failedClaim, { lastError: "previous failure", releasedAt: clock });
      const before = (await queue.listPending())[0];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const lifecycles: ChannelIngressDispatchLifecycle[] = [];
        clock += 1;
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy: { baseMs: 0, maxMs: 0 },
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycles.push(lifecycle);
            return { kind: "deferred" };
          },
        });

        await drain.drainOnce();
        await vi.waitFor(() => expect(lifecycles).toHaveLength(1));
        await expectDefined(
          expectDefined(lifecycles[0], "cancelled lifecycle").onCancelled,
          "cancel callback",
        )();
        expect(await queue.listPending()).toEqual([
          expect.objectContaining({
            id: "evt-cancel",
            attempts: before?.attempts,
            lastAttemptAt: before?.lastAttemptAt,
            lastError: before?.lastError,
          }),
        ]);
        expect(await queue.listClaims()).toEqual([]);
        drain.dispose();
      }

      const terminal = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        retryPolicy: { maxAttempts: 2, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 },
        dispatchClaimedEvent: async () => {
          throw new Error("final genuine failure");
        },
      });
      await terminal.drainOnce();
      await terminal.waitForIdle();
      expect(await queue.listFailed?.()).toEqual([
        expect.objectContaining({
          id: "evt-cancel",
          attempts: 1,
          reason: "retry-limit-exceeded",
          message: "final genuine failure",
        }),
      ]);
      terminal.dispose();
    });
  });

  it("keeps mixed modern and legacy fan-in cancellation budget-free", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("modern", { text: "x" }, { laneKey: "modern" });
      await queue.enqueue("legacy", { text: "x" }, { laneKey: "legacy" });
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        retryPolicy: { maxAttempts: 1, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 },
        dispatchClaimedEvent: async (event, lifecycle) => {
          lifecycles.set(event.id, lifecycle);
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();
      const modern = expectDefined(lifecycles.get("modern"), "modern lifecycle");
      const legacy = withoutCancellation(
        expectDefined(lifecycles.get("legacy"), "legacy lifecycle"),
      );
      await fanInChannelIngressLifecycles([modern, legacy]).cancel();

      const pending = await queue.listPending();
      expect(pending).toHaveLength(2);
      expect(pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "modern", attempts: 0 }),
          expect.objectContaining({ id: "legacy", attempts: 0 }),
        ]),
      );
      expect(await queue.listFailed?.()).toEqual([]);
      drain.dispose();
    });
  });
});
