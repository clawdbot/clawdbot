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
  clearCommandLaneGroup,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  resetAllLanes,
  setCommandLaneConcurrency,
  setCommandLaneGroup,
} from "./command-queue.js";

const CRON = "cron-nested";
const HOOK = "hook-dispatch";
const GROUP = "cron-hooks";

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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  resetAllLanes();
  clearCommandLaneGroup(GROUP);
  setCommandLaneConcurrency(CRON, 8);
  setCommandLaneConcurrency(HOOK, 1);
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
    const cronRuns = gates.map((g) => enqueueCommandInLane(CRON, async () => await g.promise));
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(7);

    // The 8th slot is the hook's hard reservation: cron must not take it.
    const extra = gate();
    const blockedCron = enqueueCommandInLane(CRON, async () => await extra.promise);
    await settle();
    expect(getCommandLaneSnapshot(CRON).activeCount).toBe(7);
    expect(getCommandLaneSnapshot(CRON).blockedBy).toBe("sibling-reservation");

    // And the hook starts immediately despite the group being otherwise full.
    const hookGate = gate();
    const hookRun = enqueueCommandInLane(HOOK, async () => await hookGate.promise);
    await settle();
    expect(getCommandLaneSnapshot(HOOK).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(HOOK).groupActive).toBe(8);

    hookGate.release();
    await hookRun;
    for (const g of gates) g.release();
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

    for (const g of gates) g.release();
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

    for (const g of gates) g.release();
    await Promise.all(runs);
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

    for (const g of gates) g.release();
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
