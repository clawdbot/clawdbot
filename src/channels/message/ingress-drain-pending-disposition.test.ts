import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";

describe("channel ingress pending disposition", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("settles stale policy rows before the existing candidate window", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("stale", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "current",
        { text: "current work" },
        { laneKey: "lane:a", receivedAt: 1 },
      );
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        scanLimit: 1,
        startLimit: 1,
        now: () => 10,
        resolvePendingDisposition: (record) =>
          record.id === "stale"
            ? { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" }
            : null,
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["current"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale", reason: "stale-ambient-backlog" },
      ]);
      drain.dispose();
    });
  });

  it("keeps pending rows claimable when a channel does not provide policy", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "channel-owned work" }, { receivedAt: 0 });
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => Number.MAX_SAFE_INTEGER,
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["old"]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it("fences a disposition CAS race without blocking unrelated lanes", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("raced", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "same-lane",
        { text: "later work" },
        { laneKey: "lane:a", receivedAt: 1 },
      );
      await queue.enqueue(
        "other-lane",
        { text: "independent" },
        { laneKey: "lane:b", receivedAt: 2 },
      );
      const fail = queue.fail.bind(queue);
      queue.fail = vi.fn(async (...args: Parameters<typeof queue.fail>) =>
        args[0] === "raced" ? false : await fail(...args),
      );
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => 10,
        resolvePendingDisposition: (record) =>
          record.id === "raced"
            ? { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" }
            : null,
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "raced",
        "same-lane",
      ]);
      drain.dispose();
    });
  });
});
