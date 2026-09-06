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
});
