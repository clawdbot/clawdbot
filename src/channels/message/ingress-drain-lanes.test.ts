import { describe, expect, it, vi } from "vitest";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain lanes", () => {
  it("preserves rejected stored lanes and attempts each snapshot candidate once", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("active", { text: "topic" }, { laneKey: "topic" });
      let releaseActive: (() => void) | undefined;
      const activeDone = new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deriveLaneKey: (record) => record.payload.text,
        reconcileStoredLaneKey: () => false,
        dispatchClaimedEvent: async (event, lifecycle) => {
          dispatches.push(event.id);
          if (event.id === "active") {
            await activeDone;
          }
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active"]));
      await queue.enqueue("candidate", { text: "topic" }, { laneKey: "control" });
      const claimNext = vi.spyOn(queue, "claimNext");

      await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      await vi.waitFor(() => expect(dispatches).toEqual(["active", "candidate"]));
      expect(claimNext).toHaveBeenCalledTimes(2);
      await expect(queue.enqueue("candidate", { text: "topic" })).resolves.toMatchObject({
        kind: "completed",
      });

      releaseActive?.();
      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
