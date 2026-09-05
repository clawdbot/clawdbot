/**
 * Atomic lane publication must never admit work before the group budget exists.
 * Park admitted tasks and sample peak concurrency at task entry so an excess
 * admission cannot disappear before the assertion observes it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "./command-queue.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const DELIVERY = "delivery-dispatch";
const GROUP = "cron-hooks";
const MOVED_GROUP = "cron-delivery";

type LaneGroupSpec = NonNullable<Parameters<typeof publishLaneConfiguration>[0]["groups"]>[string];

function setCommandLaneGroup(group: string, spec: LaneGroupSpec): void {
  publishLaneConfiguration({ groups: { [group]: spec } });
}

function clearCommandLaneGroup(group: string): void {
  publishLaneConfiguration({ clearGroups: [group] });
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
  clearCommandLaneGroup(MOVED_GROUP);
});

afterEach(() => {
  clearCommandLaneGroup(GROUP);
  clearCommandLaneGroup(MOVED_GROUP);
  resetAllLanes();
});

describe("publishLaneConfiguration", () => {
  test("no member dispatches above budget DURING publication", async () => {
    // Both lanes start closed with work already queued, so the only thing that
    // can release them is publication itself. If publication widened a lane and
    // drained it before installing the group — what the sequential per-lane
    // setter does — the two lanes would admit up to 8 + 4 = 12 tasks.
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 0);

    let active = 0;
    let peak = 0;
    const publishedStarts = createDeferred();
    const gates: Array<{ resolve: () => void }> = [];
    const runs: Array<Promise<unknown>> = [];
    const park = (lane: string) => {
      const g = createDeferred();
      gates.push(g);
      runs.push(
        enqueueCommandInLane(lane, async () => {
          active += 1;
          // Peak is sampled on entry, before anything can retire, so work
          // admitted inside the publication window cannot escape the count.
          peak = Math.max(peak, active);
          if (active >= 8) {
            publishedStarts.resolve();
          }
          await g.promise;
          active -= 1;
        }),
      );
    };
    for (let i = 0; i < 12; i++) {
      park(CRON);
    }
    for (let i = 0; i < 6; i++) {
      park(HOOK);
    }
    expect(active).toBe(0); // nothing may run before publication
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(0);

    try {
      publishLaneConfiguration({
        lanes: { [CRON]: 8, [HOOK]: 4 },
        groups: {
          [GROUP]: {
            budget: 8,
            members: [CRON, HOOK],
            reservations: { [HOOK]: 1 },
          },
        },
      });

      await withTestTimeout(
        publishedStarts.promise,
        1_000,
        "publication did not start the shared group budget",
      );

      // Sample task entry while all admitted tasks remain parked.
      expect(peak).toBeLessThanOrEqual(8);
      // And not vacuous — publication must actually have dispatched to the cap.
      expect(peak).toBe(8);
    } finally {
      for (const g of gates) {
        g.resolve();
      }
      clearCommandLane(CRON);
      clearCommandLane(HOOK);
      await Promise.allSettled(runs);
    }
  });

  test("commit dispatch uses group order rather than publication object order", async () => {
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 0);

    const starts: string[] = [];
    const cronStarted = createDeferred();
    const hookStarted = createDeferred();
    const cronGate = createDeferred();
    const hookGate = createDeferred();
    const olderCron = enqueueCommandInLane(
      CRON,
      async () => {
        starts.push(CRON);
        cronStarted.resolve();
        await cronGate.promise;
      },
      { priority: "background" },
    );
    const newerHook = enqueueCommandInLane(
      HOOK,
      async () => {
        starts.push(HOOK);
        hookStarted.resolve();
        await hookGate.promise;
      },
      { priority: "background" },
    );

    try {
      // Deliberately publish HOOK first in both objects. The older CRON head must
      // still own the single shared slot.
      publishLaneConfiguration({
        lanes: { [HOOK]: 1, [CRON]: 1 },
        groups: { [GROUP]: { budget: 1, members: [HOOK, CRON] } },
      });
      await withTestTimeout(
        cronStarted.promise,
        1_000,
        "publication did not start the older cron task",
      );
      expect(starts).toEqual([CRON]);

      cronGate.resolve();
      await olderCron;
      await withTestTimeout(
        hookStarted.promise,
        1_000,
        "cron completion did not start the queued hook",
      );
      expect(starts).toEqual([CRON, HOOK]);
    } finally {
      cronGate.resolve();
      hookGate.resolve();
      clearCommandLane(CRON);
      clearCommandLane(HOOK);
      await Promise.allSettled([olderCron, newerHook]);
    }
  });

  test("moving a busy member wakes queued work in its previous group", async () => {
    publishLaneConfiguration({
      lanes: { [CRON]: 1, [HOOK]: 1, [DELIVERY]: 1 },
      groups: { [GROUP]: { budget: 1, members: [CRON, HOOK] } },
    });

    const cronGate = createDeferred();
    const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise);
    const hookGate = createDeferred();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    // CRON's active task stops counting against the old group as soon as it is
    // moved. That newly free old-group capacity must wake HOOK immediately.
    publishLaneConfiguration({
      groups: { [MOVED_GROUP]: { budget: 1, members: [CRON, DELIVERY] } },
    });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({
      group: GROUP,
      activeCount: 1,
      queuedCount: 0,
    });
    expect(getCommandLaneSnapshot(CRON).group).toBe(MOVED_GROUP);

    cronGate.resolve();
    hookGate.resolve();
    await Promise.all([cronRun, hookRun]);
  });

  test("a rejected configuration does not leave lanes widened and dispatching", async () => {
    setCommandLaneConcurrency(CRON, 0);
    const gates = Array.from({ length: 4 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));

    // sum(reservations) > budget is rejected. Validation must happen before any
    // drain, or the lane is left open at width 8 governed by no group at all.
    expect(() =>
      publishLaneConfiguration({
        lanes: { [CRON]: 8 },
        groups: {
          [GROUP]: {
            budget: 2,
            members: [CRON, HOOK],
            reservations: { [CRON]: 2, [HOOK]: 1 },
          },
        },
      }),
    ).toThrow(/reserves 3 slots but its budget is 2/);

    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);

    for (const g of gates) {
      g.resolve();
    }
    // The lane never opened, so this work is still queued. resetAllLanes
    // PRESERVES queued entries by design, so it would never settle these —
    // clearCommandLane rejects them instead.
    clearCommandLane(CRON);
    await Promise.allSettled(runs);
  });

  test("a rejected configuration does not leave lane maxima mutated", async () => {
    // Stronger than asserting activeCount === 0 after the throw: that only
    // proves no commit-time drain ran, not that the lane was left alone. If
    // phase 1 widens a lane and group validation then throws, the lane sits at
    // the new width governed by NO group, and the next unrelated drain trigger
    // dispatches the preserved queue ungoverned.
    setCommandLaneConcurrency(CRON, 0);
    const gates = Array.from({ length: 4 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    expect(getCommandLaneSnapshot(CRON).maxConcurrent).toBe(0);

    expect(() =>
      publishLaneConfiguration({
        lanes: { [CRON]: 8 },
        groups: {
          [GROUP]: {
            budget: 2,
            members: [CRON, HOOK],
            reservations: { [CRON]: 2, [HOOK]: 1 },
          },
        },
      }),
    ).toThrow(/reserves 3 slots but its budget is 2/);

    // The lane must be exactly as it was before the rejected publish.
    expect(getCommandLaneSnapshot(CRON).maxConcurrent).toBe(0);
    expect(getCommandLaneSnapshot(CRON).group).toBeUndefined();

    // And a later drain trigger must not dispatch the queue that was preserved
    // across the failed publish.
    const extra = createDeferred();
    const extraRun = enqueueCommandInLane(CRON, async () => await extra.promise);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);

    for (const g of gates) {
      g.resolve();
    }
    extra.resolve();
    clearCommandLane(CRON);
    await Promise.allSettled([...runs, extraRun]);
  });

  test("a rejected replacement does not tear down the existing group first", async () => {
    // Combining clearGroups with an invalid replacement is the
    // worst case — the old group could be removed before the new one throws,
    // leaving BOTH lane width and group membership partially committed. Phase 0
    // validation has to run before the clear, not just before the install.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    expect(getCommandLaneSnapshot(CRON).group).toBe(GROUP);

    expect(() =>
      publishLaneConfiguration({
        lanes: { [CRON]: 99 },
        clearGroups: [GROUP],
        groups: {
          "replacement-group": {
            budget: 1,
            members: [CRON, HOOK],
            reservations: { [CRON]: 1, [HOOK]: 1 },
          },
        },
      }),
    ).toThrow(/reserves 2 slots but its budget is 1/);

    // Everything must be exactly as before: group intact, width untouched.
    expect(getCommandLaneSnapshot(CRON).group).toBe(GROUP);
    expect(getCommandLaneSnapshot(CRON).groupBudget).toBe(8);
    expect(getCommandLaneSnapshot(CRON).maxConcurrent).toBe(8);
    expect(getCommandLaneSnapshot(HOOK).reservedForLane).toBe(1);
  });

  test("publication wakes members when a replacement frees capacity", async () => {
    // Replacing a group must wake queued members when its new budget has room,
    // without waiting for an unrelated enqueue to trigger another drain.
    setCommandLaneConcurrency(CRON, 8);
    setCommandLaneConcurrency(HOOK, 1);
    setCommandLaneGroup(GROUP, { budget: 2, members: [CRON, HOOK] });

    const gates = Array.from({ length: 5 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(2);
    expect(getCommandLaneSnapshot(CRON).queuedCount).toBe(3);

    // Publish a wider group budget without changing individual lane widths.
    setCommandLaneGroup(GROUP, { budget: 5, members: [CRON, HOOK] });

    // The queued work must start on the replacement itself.
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(5);
    expect(getCommandLaneSnapshot(CRON).queuedCount).toBe(0);

    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(runs);
  });

  test("republishing a narrower budget does not admit beyond the new cap", async () => {
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });

    const gates = Array.from({ length: 3 }, () => createDeferred());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);

    // Narrowing mid-flight cannot evict running work, but it must not admit
    // more: the group is already over its new budget.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 2, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    const extra = createDeferred();
    const blocked = enqueueCommandInLane(CRON, async () => await extra.promise);

    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("group-budget");

    for (const g of gates) {
      g.resolve();
    }
    extra.resolve();
    clearCommandLane(CRON);
    await Promise.allSettled([...runs, blocked]);
  });
});
