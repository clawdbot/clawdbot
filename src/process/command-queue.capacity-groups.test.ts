/**
 * Capacity groups: a shared hard budget across lanes, with non-borrowable
 * per-member reservations.
 *
 * The invariant under test is the one the upstream maintainer asked for on
 * openclaw#98813: giving hook dispatch its own lane must NOT add a concurrent
 * slot outside the existing cron budget. A group whose budget equals that cap
 * is what makes the separate lane safe.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  resetAllLanes,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "./command-queue.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const DELIVERY = "delivery-dispatch";
const GROUP = "cron-hooks";

type LaneGroupSpec = NonNullable<Parameters<typeof publishLaneConfiguration>[0]["groups"]>[string];

function setCommandLaneGroup(group: string, spec: LaneGroupSpec): void {
  publishLaneConfiguration({ groups: { [group]: spec } });
}

function clearCommandLaneGroup(group: string): void {
  publishLaneConfiguration({ clearGroups: [group] });
}

/** A task that blocks until released, so occupancy is controllable. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
  setCommandLaneConcurrency(CRON, 8);
  setCommandLaneConcurrency(HOOK, 8);
  setCommandLaneConcurrency(DELIVERY, 8);
});

afterEach(() => {
  clearCommandLaneGroup(GROUP);
  resetAllLanes();
});

describe("command lane capacity groups", () => {
  test("a reserved lane starts under sibling saturation", async () => {
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    // Fill the group to its budget minus the hook's reservation.
    const gates = Array.from({ length: 7 }, () => gate());
    const cronRuns = gates.map((g) =>
      enqueueCommandInLane(CRON, async () => await g.promise, { priority: "foreground" }),
    );
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(7);

    // The 8th slot is the hook's hard reservation: cron must not take it.
    const waiting: string[] = [];
    const extra = gate();
    const blockedCron = enqueueCommandInLane(CRON, async () => await extra.promise, {
      priority: "foreground",
      onQueued: () => waiting.push(CRON),
    });
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(7);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("sibling-reservation");

    // And the hook starts immediately despite the group being otherwise full.
    const hookGate = gate();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
      onQueued: () => waiting.push(HOOK),
    });
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK).groupActive).toBe(8);
    expect(waiting).toEqual([CRON]);

    hookGate.release();
    await hookRun;
    for (const g of gates) {
      g.release();
    }
    extra.release();
    await Promise.all([...cronRuns, blockedCron]);
  });

  test("total active never exceeds the group budget", async () => {
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    const gates = Array.from({ length: 20 }, () => gate());
    const runs = gates.map((g, i) =>
      enqueueCommandInLane(i % 2 === 0 ? CRON : HOOK, async () => await g.promise),
    );
    await settle();

    const cron = getCommandLaneSnapshot(CRON);
    const hook = getCommandLaneSnapshot(HOOK);
    expect(cron.activeCount + hook.activeCount).toBeLessThanOrEqual(8);
    // Not vacuous: the group must actually be saturated, not merely under cap.
    expect(cron.activeCount + hook.activeCount).toBe(8);

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  test("a member may use the full group budget beyond its reservation", async () => {
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    const gates = Array.from({ length: 9 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane(HOOK, async () => await g.promise));
    await settle();

    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({
      activeCount: 8,
      queuedCount: 1,
      maxConcurrent: 8,
      groupActive: 8,
      groupBudget: 8,
      reservedForLane: 1,
      blockedBy: "lane",
    });

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  test("capacity freed by one member wakes a queued sibling", async () => {
    setCommandLaneGroup(GROUP, { budget: 2, members: [CRON, HOOK] });

    const a = gate();
    const b = gate();
    const first = enqueueCommandInLane(CRON, async () => await a.promise);
    const second = enqueueCommandInLane(CRON, async () => await b.promise);
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(2);

    // Budget is full, so the hook cannot start.
    const hookGate = gate();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(0);
    expect(getCommandLaneSnapshot(HOOK).blockedBy).toBe("group-budget");

    // Releasing a cron task must wake the hook, which lives on a DIFFERENT
    // lane — a lane-local pump would leave it queued behind free capacity.
    a.release();
    await first;
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);

    hookGate.release();
    b.release();
    await Promise.all([second, hookRun]);
  });

  test.each(["successful", "failing"] as const)(
    "a %s completion gives shared capacity to the older eligible sibling head",
    async (outcome) => {
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CRON, HOOK],
        reservations: { [HOOK]: 1 },
      });

      const firstHookGate = gate();
      const secondHookGate = gate();
      const firstHook = enqueueCommandInLane(
        HOOK,
        async () => {
          await firstHookGate.promise;
          if (outcome === "failing") {
            throw new Error("expected hook failure");
          }
        },
        { priority: "background" },
      );
      const secondHook = enqueueCommandInLane(HOOK, async () => await secondHookGate.promise, {
        priority: "background",
      });
      await settle();
      expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(2);

      // Cron queues first. A later hook queues behind the same full group. The
      // completing hook lane must not synchronously reclaim the shared slot.
      const cronGate = gate();
      const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
        priority: "background",
      });
      const thirdHookGate = gate();
      const thirdHook = enqueueCommandInLane(HOOK, async () => await thirdHookGate.promise, {
        priority: "background",
      });
      await settle();

      firstHookGate.release();
      if (outcome === "failing") {
        await expect(firstHook).rejects.toThrow("expected hook failure");
      } else {
        await firstHook;
      }
      await settle();

      expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 1, queuedCount: 0 });
      expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 1 });

      cronGate.release();
      secondHookGate.release();
      thirdHookGate.release();
      await Promise.all([cronRun, secondHook, thirdHook]);
    },
  );

  test("priority outranks group-global enqueue sequence", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });

    const blockerGate = gate();
    const blocker = enqueueCommandInLane(HOOK, async () => await blockerGate.promise);
    await settle();

    const cronGate = gate();
    const olderBackground = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
      priority: "background",
    });
    const hookGate = gate();
    const newerForeground = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "foreground",
    });

    blockerGate.release();
    await blocker;
    await settle();

    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    hookGate.release();
    await newerForeground;
    cronGate.release();
    await olderBackground;
  });

  test("three-member arbitration is independent of member iteration order", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK, DELIVERY] });

    const blockerGate = gate();
    const blocker = enqueueCommandInLane(CRON, async () => await blockerGate.promise, {
      priority: "background",
    });
    await settle();

    // DELIVERY is last in the member Set but queues before HOOK. A simple
    // sibling-first loop would start HOOK merely because it is visited first.
    const deliveryGate = gate();
    const olderDelivery = enqueueCommandInLane(DELIVERY, async () => await deliveryGate.promise, {
      priority: "background",
    });
    const hookGate = gate();
    const newerHook = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
    });

    blockerGate.release();
    await blocker;
    await settle();

    expect(getCommandLaneSnapshot(DELIVERY)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    deliveryGate.release();
    await olderDelivery;
    hookGate.release();
    await newerHook;
  });

  test("multi-slot reset re-arbitrates before stale completions arrive", async () => {
    setCommandLaneGroup(GROUP, { budget: 2, members: [CRON, HOOK] });

    const staleGates = [gate(), gate()];
    const staleHooks = staleGates.map((g) =>
      enqueueCommandInLane(HOOK, async () => await g.promise, { priority: "background" }),
    );
    await settle();

    const cronGate = gate();
    const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
      priority: "background",
    });
    const queuedHookGates = [gate(), gate()];
    const queuedHooks = queuedHookGates.map((g) =>
      enqueueCommandInLane(HOOK, async () => await g.promise, { priority: "background" }),
    );
    await settle();

    expect(resetCommandLane(HOOK)).toBe(2);
    await settle();
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 1 });
    expect(getCommandLaneSnapshot(HOOK).groupActive).toBe(2);

    // The reset invalidated these task IDs. Their late completions must neither
    // remove new-generation IDs nor admit the remaining queued hook.
    for (const g of staleGates) {
      g.release();
    }
    await Promise.all(staleHooks);
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 1, queuedCount: 1 });

    cronGate.release();
    queuedHookGates[0]?.release();
    await Promise.all([cronRun, queuedHooks[0]]);
    queuedHookGates[1]?.release();
    await queuedHooks[1];
  });

  test("resetAllLanes refills a group by queue order rather than lane order", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [HOOK, CRON] });

    const staleGate = gate();
    const staleHook = enqueueCommandInLane(HOOK, async () => await staleGate.promise, {
      priority: "background",
    });
    await settle();

    const cronGate = gate();
    const olderCron = enqueueCommandInLane(CRON, async () => await cronGate.promise, {
      priority: "background",
    });
    const hookGate = gate();
    const newerHook = enqueueCommandInLane(HOOK, async () => await hookGate.promise, {
      priority: "background",
    });
    await settle();

    resetAllLanes();
    await settle();
    expect(getCommandLaneSnapshot(CRON)).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    staleGate.release();
    await staleHook;
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK).queuedCount).toBe(1);

    cronGate.release();
    await olderCron;
    hookGate.release();
    await newerHook;
  });

  test("commits a slot before an onWait callback can re-enter the group", async () => {
    setCommandLaneConcurrency(CRON, 0);
    setCommandLaneConcurrency(HOOK, 1);

    const cronGate = gate();
    const hookGate = gate();
    let hookRun: Promise<void> | undefined;
    let active = 0;
    let peak = 0;
    const cronRun = enqueueCommandInLane(
      CRON,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await cronGate.promise;
        active -= 1;
      },
      {
        priority: "background",
        warnAfterMs: 0,
        onWait: () => {
          hookRun = enqueueCommandInLane(
            HOOK,
            async () => {
              active += 1;
              peak = Math.max(peak, active);
              await hookGate.promise;
              active -= 1;
            },
            { priority: "foreground" },
          );
        },
      },
    );
    await settle();

    publishLaneConfiguration({
      lanes: { [CRON]: 1 },
      groups: { [GROUP]: { budget: 1, members: [CRON, HOOK] } },
    });
    await settle();

    expect(hookRun).toBeDefined();
    expect(peak).toBe(1);
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK)).toMatchObject({ activeCount: 0, queuedCount: 1 });

    cronGate.release();
    await cronRun;
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    hookGate.release();
    await hookRun;
    expect(peak).toBe(1);
  });

  test("a failing task releases group capacity like a successful one", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });

    const boom = gate();
    const failing = enqueueCommandInLane(CRON, async () => {
      await boom.promise;
      throw new Error("task blew up");
    });
    await settle();

    const hookGate = gate();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(0);

    boom.release();
    await expect(failing).rejects.toThrow("task blew up");
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);

    hookGate.release();
    await hookRun;
  });

  test("a timed-out task releases group capacity to a queued sibling", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });

    const timedOut = enqueueCommandInLane(CRON, async () => new Promise<never>(() => {}), {
      taskTimeoutMs: 10,
    });
    const hookGate = gate();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);

    await expect(timedOut).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);

    hookGate.release();
    await hookRun;
  });

  test("resetting a member releases group capacity to a queued sibling", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });

    const cronGate = gate();
    const cronRun = enqueueCommandInLane(CRON, async () => await cronGate.promise);
    await settle();

    const hookGate = gate();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(0);

    expect(resetCommandLane(CRON)).toBe(1);
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);

    cronGate.release();
    hookGate.release();
    await Promise.all([cronRun, hookRun]);
  });

  test("an idle sibling's reservation is withheld, not borrowed", async () => {
    setCommandLaneGroup(GROUP, {
      budget: 4,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    const gates = Array.from({ length: 6 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    await settle();

    // 3, not 4: the hook is idle but its reserved slot is genuinely held back.
    // A borrowable reservation would show 4 here and starve the hook.
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(3);

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  test("blockedBy reports hypothetical immediate admission with an EMPTY queue", async () => {
    // The non-vacuity condition for the whole wait-visibility fix.
    //
    // `noteLaneWaitIfBusy` runs BEFORE enqueue, so it sees queuedCount === 0. If
    // blockedBy were only populated for an already-queued head entry, the
    // pre-enqueue snapshot would read "not blocked", no onLaneWait(waiting:true)
    // would fire, and agent-watchdog's setup-timeout suppression would never
    // engage — producing a false setup timeout for a run that is merely waiting
    // on group capacity. blockedBy must answer "could this lane start work right
    // now?", independent of whether anything is queued.
    setCommandLaneGroup(GROUP, {
      budget: 8,
      members: [CRON, HOOK],
      reservations: { [HOOK]: 1 },
    });

    const gates = Array.from({ length: 7 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    await settle();

    const snapshot = getCommandLaneSnapshot(CRON);
    // Nothing queued, and the lane is under its own maxConcurrent of 8...
    expect(snapshot.queuedCount).toBe(0);
    expect(snapshot.activeCount).toBeLessThan(snapshot.maxConcurrent);
    // ...yet it genuinely cannot start: the last slot is the hook's reserve.
    expect(snapshot.blockedBy).toBe("sibling-reservation");

    // A lane with room reports null, so the assertion above is discriminating
    // rather than always-truthy.
    expect(getCommandLaneSnapshot(HOOK).blockedBy).toBeNull();

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  test("an unmaterialized lane still reports its group block state", async () => {
    // A member lane may not exist yet (never enqueued) or may have been retired
    // while idle. `noteLaneWaitIfBusy` can snapshot it in exactly that state, so
    // the not-found path must consult the group rather than return a bare
    // default that reads as "free".
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });
    const busy = gate();
    const run = enqueueCommandInLane(CRON, async () => await busy.promise);
    await settle();

    const snapshot = getCommandLaneSnapshot(HOOK);
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.blockedBy).toBe("group-budget");
    expect(snapshot.groupBudget).toBe(1);

    busy.release();
    await run;
  });

  test("lanes outside any group are unconstrained by it", async () => {
    setCommandLaneGroup(GROUP, { budget: 1, members: [CRON, HOOK] });
    setCommandLaneConcurrency("unpooled", 4);

    const gates = Array.from({ length: 4 }, () => gate());
    const runs = gates.map((g) => enqueueCommandInLane("unpooled", async () => await g.promise));
    await settle();
    expect(getCommandLaneSnapshot("unpooled").activeCount).toBe(4);
    expect(getCommandLaneSnapshot("unpooled").blockedBy).toBe("lane");
    expect(getCommandLaneSnapshot("unpooled").group).toBeUndefined();

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  test("rejects reservations that exceed the budget", () => {
    expect(() =>
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CRON, HOOK],
        reservations: { [CRON]: 2, [HOOK]: 1 },
      }),
    ).toThrow(/reserves 3 slots but its budget is 2/);
  });

  test("rejects lanes that can be synchronously awaited", () => {
    // `cron` awaits `cron-nested`; grouping them turns a wait into a deadlock.
    expect(() => setCommandLaneGroup(GROUP, { budget: 2, members: ["cron", HOOK] })).toThrow(
      /cannot join a capacity group/,
    );
    expect(() => setCommandLaneGroup(GROUP, { budget: 2, members: ["session:abc", HOOK] })).toThrow(
      /cannot join a capacity group/,
    );
    expect(() => setCommandLaneGroup(GROUP, { budget: 2, members: ["main", HOOK] })).toThrow(
      /cannot join a capacity group/,
    );
  });

  test("rejects a reservation for a non-member lane", () => {
    expect(() =>
      setCommandLaneGroup(GROUP, {
        budget: 2,
        members: [CRON],
        reservations: { [HOOK]: 1 },
      }),
    ).toThrow(/reserves for non-member lane/);
  });
});
