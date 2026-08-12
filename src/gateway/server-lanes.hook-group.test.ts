/**
 * The cron+hook capacity group is opt-in on `hooks.enabled`.
 *
 * The reservation is a real cost: it withholds a slot from cron inner work even
 * while the hook lane is idle. That price buys the guarantee that hooks cannot
 * be starved by a saturated cron budget — so it is only paid by deployments
 * that actually run hooks. With hooks disabled no group is installed and
 * `cron-nested` keeps the entire cron budget, unchanged from before this
 * feature existed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

function publish(config: OpenClawConfig): void {
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config));
}

const HOOKS_ON = {
  hooks: { enabled: true, token: "t" },
} as unknown as OpenClawConfig;
const HOOKS_OFF = {} as OpenClawConfig;

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

describe("cron+hook capacity group", () => {
  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    const { resetSessionSuspensionStateForTest } =
      await import("../agents/session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    resetCommandQueueStateForTest();
  });

  it("installs no group when hooks are disabled, leaving cron at full budget", async () => {
    publish(HOOKS_OFF);

    const snapshot = getCommandLaneSnapshot(CommandLane.CronNested);
    expect(snapshot.group).toBeUndefined();
    expect(snapshot.maxConcurrent).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);

    const gates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
    const runs = gates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    // The whole budget, not budget-minus-a-reservation.
    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  it("installs the group when hooks are enabled and reserves a slot for them", async () => {
    publish(HOOKS_ON);

    const snapshot = getCommandLaneSnapshot(CommandLane.CronNested);
    expect(snapshot.group).toBe("cron-hooks");
    expect(snapshot.groupBudget).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch)).toMatchObject({
      maxConcurrent: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      reservedForLane: 1,
    });

    const gates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
    const runs = gates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    // One short of the budget: the hook's reserved slot is withheld even though
    // the hook lane is idle. This is the cost the opt-in exists to avoid paying
    // on deployments that do not use hooks.
    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    );

    // And a hook starts immediately despite cron holding everything else.
    const hookGate = gate();
    const hookRun = enqueueCommandInLane(
      CommandLane.HookDispatch,
      async () => await hookGate.promise,
      { warnAfterMs: 10_000 },
    );
    await settle();
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).activeCount).toBe(1);

    // Aggregate is exactly the pre-existing cron cap — no slot added outside it.
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).groupActive).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );

    hookGate.release();
    await hookRun;
    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  it("admits hook bursts up to the shared budget and queues the ninth", async () => {
    publish(HOOKS_ON);

    const gates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS + 1 }, () => gate());
    const runs = gates.map((g) =>
      enqueueCommandInLane(CommandLane.HookDispatch, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    expect(getCommandLaneSnapshot(CommandLane.HookDispatch)).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      queuedCount: 1,
      groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      groupBudget: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    });

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  it("admits seven cron plus one hook, then gives freed capacity to a second hook", async () => {
    publish(HOOKS_ON);

    const cronGates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1 }, () => gate());
    const cronRuns = cronGates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    const firstHookGate = gate();
    const firstHook = enqueueCommandInLane(
      CommandLane.HookDispatch,
      async () => await firstHookGate.promise,
      { warnAfterMs: 10_000 },
    );
    await settle();

    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    );
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).activeCount).toBe(1);
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).groupActive).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );

    const secondHookGate = gate();
    const secondHook = enqueueCommandInLane(
      CommandLane.HookDispatch,
      async () => await secondHookGate.promise,
      { warnAfterMs: 10_000 },
    );
    await settle();
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).queuedCount).toBe(1);

    cronGates[0]?.release();
    await cronRuns[0];
    await settle();

    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - 2,
    );
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).activeCount).toBe(2);
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).groupActive).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );

    firstHookGate.release();
    secondHookGate.release();
    for (const g of cronGates.slice(1)) {
      g.release();
    }
    await Promise.all([...cronRuns.slice(1), firstHook, secondHook]);
  });

  it("hooks-off immediately drains cron work released by the teardown", async () => {
    // Teardown must WAKE the lanes it frees, not merely delete membership.
    // Asserting only `group === undefined` on an idle lane would pass even if
    // clearGroups forgot to add its former members to the commit-drain set,
    // leaving released work stuck until some unrelated enqueue pokes the lane.
    publish(HOOKS_ON);

    const gates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
    const runs = gates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    // One short of the budget, with the last entry queued behind the hook's
    // reservation rather than running.
    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    );
    expect(getCommandLaneSnapshot(CommandLane.CronNested).queuedCount).toBe(1);
    expect(getCommandLaneSnapshot(CommandLane.CronNested).blockedBy).toBe("sibling-reservation");

    // Turning hooks off returns the reserved slot to cron. The queued entry
    // must start on the publish itself.
    publish(HOOKS_OFF);
    await settle();

    expect(getCommandLaneSnapshot(CommandLane.CronNested).group).toBeUndefined();
    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );
    expect(getCommandLaneSnapshot(CommandLane.CronNested).queuedCount).toBe(0);

    for (const g of gates) {
      g.release();
    }
    await Promise.all(runs);
  });

  it("keeps in-flight hooks inside the aggregate budget while disabling hooks", async () => {
    publish(HOOKS_ON);

    const hookGate = gate();
    const hookRun = enqueueCommandInLane(
      CommandLane.HookDispatch,
      async () => await hookGate.promise,
      { warnAfterMs: 10_000 },
    );
    const cronGates = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () => gate());
    const cronRuns = cronGates.map((g) =>
      enqueueCommandInLane(CommandLane.CronNested, async () => await g.promise, {
        warnAfterMs: 10_000,
      }),
    );
    await settle();

    expect(getCommandLaneSnapshot(CommandLane.CronNested).activeCount).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
    );
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).groupActive).toBe(
      DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    );

    publish(HOOKS_OFF);
    await settle();

    // The lane closes before the group reservation is removed. The running hook
    // remains grouped, so cron cannot expand beyond the original aggregate cap.
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch)).toMatchObject({
      maxConcurrent: 0,
      group: "cron-hooks",
      reservedForLane: 0,
      activeCount: 1,
    });
    expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1,
      queuedCount: 1,
      groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    });

    let lateHookStarted = false;
    const lateHook = enqueueCommandInLane(CommandLane.HookDispatch, async () => {
      lateHookStarted = true;
    });
    await settle();
    expect(lateHookStarted).toBe(false);
    expect(getCommandLaneSnapshot(CommandLane.HookDispatch).queuedCount).toBe(1);

    hookGate.release();
    await hookRun;
    await settle();

    // Hook completion hands its slot to cron, not to work queued on the closed
    // hook lane, and aggregate activity remains bounded by the same group.
    expect(getCommandLaneSnapshot(CommandLane.CronNested)).toMatchObject({
      activeCount: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
      queuedCount: 0,
      groupActive: DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    });
    expect(lateHookStarted).toBe(false);

    for (const g of cronGates) {
      g.release();
    }
    await Promise.all(cronRuns);

    publish(HOOKS_ON);
    await lateHook;
    expect(lateHookStarted).toBe(true);
  });

  it("removes the group when hooks are turned off by a config reload", async () => {
    publish(HOOKS_ON);
    expect(getCommandLaneSnapshot(CommandLane.CronNested).group).toBe("cron-hooks");

    publish(HOOKS_OFF);
    // Membership must actually be torn down, or cron keeps paying a reservation
    // for a lane that no longer receives work.
    expect(getCommandLaneSnapshot(CommandLane.CronNested).group).toBeUndefined();
    expect(getCommandLaneSnapshot(CommandLane.CronNested).blockedBy).toBeNull();
  });
});
