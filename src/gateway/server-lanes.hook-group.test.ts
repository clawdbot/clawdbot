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
    await new Promise((resolve) => setTimeout(resolve, 0));
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

    for (const g of gates) g.release();
    await Promise.all(runs);
  });

  it("installs the group when hooks are enabled and reserves a slot for them", async () => {
    publish(HOOKS_ON);

    const snapshot = getCommandLaneSnapshot(CommandLane.CronNested);
    expect(snapshot.group).toBe("cron-hooks");
    expect(snapshot.groupBudget).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);

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
    for (const g of gates) g.release();
    await Promise.all(runs);
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
