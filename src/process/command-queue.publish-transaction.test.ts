/**
 * Atomic lane-configuration publication.
 *
 * Round-4 review (fiducian-spencer-001) asked specifically for a regression
 * that "would fail if any member drains during publication before the group is
 * installed, not just a post-state assertion". A post-state check is too weak:
 * work admitted above budget during the publication window can complete before
 * the assertion runs, leaving final counts looking correct.
 *
 * These tests therefore observe PEAK concurrency across the window, using tasks
 * that park so nothing can retire before it is counted.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearCommandLaneGroup,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  setCommandLaneConcurrency,
} from "./command-queue.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const GROUP = "cron-hooks";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
});

afterEach(() => {
  clearCommandLaneGroup(GROUP);
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
    const gates: Array<{ release: () => void }> = [];
    const runs: Array<Promise<unknown>> = [];
    const park = (lane: string) => {
      const g = gate();
      gates.push(g);
      runs.push(
        enqueueCommandInLane(lane, async () => {
          active += 1;
          // Peak is sampled on entry, before anything can retire, so work
          // admitted inside the publication window cannot escape the count.
          peak = Math.max(peak, active);
          await g.promise;
          active -= 1;
        }),
      );
    };
    for (let i = 0; i < 12; i++) park(CRON);
    for (let i = 0; i < 6; i++) park(HOOK);
    await settle();
    expect(active).toBe(0); // nothing may run before publication

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
    await settle();

    // The assertion the review asked for: peak, not final state.
    expect(peak).toBeLessThanOrEqual(8);
    // And not vacuous — publication must actually have dispatched to the cap.
    expect(peak).toBe(8);

    for (const g of gates) g.release();
    await Promise.all(runs);
  });

  test("a rejected configuration does not leave lanes widened and dispatching", async () => {
    setCommandLaneConcurrency(CRON, 0);
    const gates = Array.from({ length: 4 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    await settle();

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
    await settle();

    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(0);

    for (const g of gates) g.release();
    // The lane never opened, so these stay queued; clear them for teardown.
    resetAllLanes();
    await Promise.allSettled(runs);
  });

  test("republishing a narrower budget does not admit beyond the new cap", async () => {
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 8, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });

    const gates = Array.from({ length: 3 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);

    // Narrowing mid-flight cannot evict running work, but it must not admit
    // more: the group is already over its new budget.
    publishLaneConfiguration({
      lanes: { [CRON]: 8, [HOOK]: 1 },
      groups: {
        [GROUP]: { budget: 2, members: [CRON, HOOK], reservations: { [HOOK]: 1 } },
      },
    });
    const extra = gate();
    const blocked = enqueueCommandInLane(CRON, async () => await extra.promise);
    await settle();

    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("group-budget");

    for (const g of gates) g.release();
    extra.release();
    resetAllLanes();
    await Promise.allSettled([...runs, blocked]);
  });
});
