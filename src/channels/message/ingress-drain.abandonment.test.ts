import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain abandonment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("applies the failure disposition once per abandonment and stops at the threshold", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const maxAttempts = 3;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("abandoned", { text: "x" }, { laneKey: "l", receivedAt: 1 });
      const fail = vi.spyOn(queue, "fail");
      const pendingPerPass: Array<Array<{ attempts: number }>> = [];

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        clock += 1;
        const drain = createChannelIngressDrain<Payload>({
          queue,
          now: () => clock,
          retryPolicy: { maxAttempts, deadLetterMinAgeMs: 0, baseMs: 0, maxMs: 0 },
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await Promise.all([lifecycle.onAbandoned(), lifecycle.onAbandoned()]);
            return { kind: "deferred" };
          },
        });
        await drain.drainOnce();
        await drain.waitForIdle();
        drain.dispose();
        pendingPerPass.push(await queue.listPending());
      }

      expect(pendingPerPass).toEqual([
        [expect.objectContaining({ id: "abandoned", attempts: 1 })],
        [expect.objectContaining({ id: "abandoned", attempts: 2 })],
        [],
      ]);
      expect(fail).toHaveBeenCalledOnce();
      expect(await queue.listFailed?.()).toEqual([
        expect.objectContaining({
          id: "abandoned",
          attempts: maxAttempts - 1,
          reason: "retry-limit-exceeded",
          message: "turn-abandoned",
          payload: { text: "x" },
        }),
      ]);
    });
  });
});
