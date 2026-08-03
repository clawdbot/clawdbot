import {
  enableSessionSuspensionTimersForGatewayStart,
  getSuspendedLaneIdsForGatewayPublication,
  setGatewayLaneResumeConcurrencies,
} from "../agents/session-suspension.js";
// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

type GatewayLaneConcurrency = {
  cron: number;
  /**
   * Width of the hook lane, or 0 when hooks are disabled.
   *
   * Zero is meaningful: a steady-state hooks-off publication creates no group,
   * so a deployment that does not use hooks keeps the full cron budget and sees
   * no behaviour change from this feature.
   */
  hookDispatch: number;
  main: number;
  subagent: number;
};

/** Capacity held inside the cron budget so hook dispatch cannot be starved. */
const HOOK_DISPATCH_LANE_RESERVATION = 1;

/** Group bounding cron inner work and hook dispatch to one shared budget. */
const CRON_HOOK_LANE_GROUP = "cron-hooks";

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  const cron = resolveCronMaxConcurrentRuns();
  return {
    cron,
    // The reservation guarantees one slot, but hooks may use every free slot
    // inside the shared budget. A one-wide lane would serialize unrelated hooks.
    hookDispatch: cfg.hooks?.enabled === true ? cron : 0,
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

export function applyGatewayLaneConcurrency(
  concurrency: GatewayLaneConcurrency,
  opts: { gatewayStart?: boolean } = {},
): void {
  setGatewayLaneResumeConcurrencies({
    [CommandLane.Cron]: concurrency.cron,
    [CommandLane.CronNested]: concurrency.cron,
    [CommandLane.HookDispatch]: concurrency.hookDispatch,
    [CommandLane.Main]: concurrency.main,
    [CommandLane.Nested]: 1,
    [CommandLane.Subagent]: concurrency.subagent,
  });
  // Lane ids are open strings (plugins mint their own); narrow once so the
  // gateway-managed cases compare within the enum.
  const suspendedLaneIds: ReadonlySet<string> = opts.gatewayStart
    ? enableSessionSuspensionTimersForGatewayStart()
    : getSuspendedLaneIdsForGatewayPublication();
  // Resolution is deliberately separate: this commit-edge applier only updates
  // live queue state and cannot reject a config midway through publication.
  if (!suspendedLaneIds.has(CommandLane.Cron)) {
    setCommandLaneConcurrency(CommandLane.Cron, concurrency.cron);
  }
  // `cron-nested` (cron inner agent work) and `hook-dispatch` (external hook
  // agent runs) are published as ONE transaction together with the group that
  // bounds them. Applying them with the per-lane setter would drain each lane
  // the moment it went positive — before the group existed — so both could
  // dispatch up to their individual maxima and exceed the shared budget. That
  // is precisely the additive-capacity behaviour openclaw#98813 was held for.
  const hooksEnabled = concurrency.hookDispatch > 0;
  const hookSnapshot = getCommandLaneSnapshot(CommandLane.HookDispatch);
  // Closing hooks must not detach already-running hook work from the shared
  // budget while cron immediately expands back to its full width. Retain the
  // group without a reservation until a later publication sees no active hook.
  const retainInFlightHookBudget = !hooksEnabled && hookSnapshot.activeCount > 0;
  const grouped: Record<string, number> = {};
  if (!suspendedLaneIds.has(CommandLane.CronNested)) {
    grouped[CommandLane.CronNested] = concurrency.cron;
  }
  if (!suspendedLaneIds.has(CommandLane.HookDispatch)) {
    grouped[CommandLane.HookDispatch] = concurrency.hookDispatch;
  }
  // Publish even when `grouped` is empty. Both lanes can be suspended during
  // config reload, but the group still needs its reservation updated or its
  // membership cleared before their independent resume timers reopen them.
  publishLaneConfiguration({
    lanes: grouped,
    // Opt-in. A clean hooks-off publication installs no group and
    // `cron-nested` keeps the entire cron budget. During an enabled-to-disabled
    // transition, a zero-reservation group may remain while in-flight hooks
    // finish so aggregate work stays bounded without withholding idle capacity.
    groups:
      hooksEnabled || retainInFlightHookBudget
        ? {
            // Budget equals the existing cron cap, so the hook lane costs
            // nothing in AGGREGATE concurrency; it reserves one slot inside
            // that cap rather than adding one outside it. Cron inner work
            // trades one slot for the guarantee that hooks cannot be starved.
            [CRON_HOOK_LANE_GROUP]: {
              budget: concurrency.cron,
              members: [CommandLane.CronNested, CommandLane.HookDispatch],
              reservations: hooksEnabled
                ? { [CommandLane.HookDispatch]: HOOK_DISPATCH_LANE_RESERVATION }
                : undefined,
            },
          }
        : undefined,
    clearGroups: hooksEnabled || retainInFlightHookBudget ? undefined : [CRON_HOOK_LANE_GROUP],
  });
  if (!suspendedLaneIds.has(CommandLane.Main)) {
    setCommandLaneConcurrency(CommandLane.Main, concurrency.main);
  }
  if (opts.gatewayStart) {
    // sessions.send work uses a shared nested lane with no config knob; live
    // reload must not resume a currently suspended nested lane before its TTL.
    if (!suspendedLaneIds.has(CommandLane.Nested)) {
      setCommandLaneConcurrency(CommandLane.Nested, 1);
    }
  }
  if (!suspendedLaneIds.has(CommandLane.Subagent)) {
    setCommandLaneConcurrency(CommandLane.Subagent, concurrency.subagent);
  }
}
