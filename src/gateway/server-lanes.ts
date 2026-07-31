import {
  enableSessionSuspensionTimersForGatewayStart,
  getCleanupSuspendedLaneIdsForGatewayPublication,
} from "../agents/session-suspension.js";
// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishLaneConfiguration, setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

type GatewayLaneConcurrency = {
  cron: number;
  /**
   * Width of the hook lane, or 0 when hooks are disabled.
   *
   * Zero is meaningful: with hooks off no group is created at all, so a
   * deployment that does not use hooks keeps the full cron budget and sees no
   * behaviour change from this feature.
   */
  hookDispatch: number;
  main: number;
  subagent: number;
};

/** Hook agent runs serialize against each other; the lane is one-wide by design. */
const HOOK_DISPATCH_LANE_CONCURRENCY = 1;

/** Group bounding cron inner work and hook dispatch to one shared budget. */
export const CRON_HOOK_LANE_GROUP = "cron-hooks";

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  return {
    cron: resolveCronMaxConcurrentRuns(),
    hookDispatch: cfg.hooks?.enabled === true ? HOOK_DISPATCH_LANE_CONCURRENCY : 0,
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

export function applyGatewayLaneConcurrency(
  concurrency: GatewayLaneConcurrency,
  opts: { gatewayStart?: boolean } = {},
): void {
  // Lane ids are open strings (plugins mint their own); narrow once so the
  // gateway-managed cases compare within the enum.
  const suspendedLaneIds: ReadonlySet<string> = opts.gatewayStart
    ? enableSessionSuspensionTimersForGatewayStart((laneId, savedResumeConcurrency) => {
        switch (laneId as CommandLane) {
          case CommandLane.Cron:
          case CommandLane.CronNested:
            return concurrency.cron;
          case CommandLane.HookDispatch:
            return concurrency.hookDispatch;
          case CommandLane.Main:
            return concurrency.main;
          case CommandLane.Nested:
            return 1;
          case CommandLane.Subagent:
            return concurrency.subagent;
          default:
            return savedResumeConcurrency;
        }
      })
    : getCleanupSuspendedLaneIdsForGatewayPublication();
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
  const grouped: Record<string, number> = {};
  if (!suspendedLaneIds.has(CommandLane.CronNested)) {
    grouped[CommandLane.CronNested] = concurrency.cron;
  }
  if (hooksEnabled && !suspendedLaneIds.has(CommandLane.HookDispatch)) {
    // One-wide: the guarantee is that a hook can always START under cron
    // saturation, not that hooks run concurrently with each other.
    grouped[CommandLane.HookDispatch] = concurrency.hookDispatch;
  }
  if (Object.keys(grouped).length > 0) {
    publishLaneConfiguration({
      lanes: grouped,
      // Opt-in. With hooks disabled there is no hook work to protect, so no
      // group is installed and `cron-nested` keeps the entire cron budget —
      // such a deployment sees no behaviour change at all. The reservation is
      // a real cost (it withholds a slot from cron even while idle), so it is
      // only paid where it buys something.
      groups: hooksEnabled
        ? {
            // Budget equals the existing cron cap, so the hook lane costs
            // nothing in AGGREGATE concurrency; it reserves one slot inside
            // that cap rather than adding one outside it. Cron inner work
            // trades one slot for the guarantee that hooks cannot be starved.
            [CRON_HOOK_LANE_GROUP]: {
              budget: concurrency.cron,
              members: [CommandLane.CronNested, CommandLane.HookDispatch],
              reservations: { [CommandLane.HookDispatch]: concurrency.hookDispatch },
            },
          }
        : undefined,
      clearGroups: hooksEnabled ? undefined : [CRON_HOOK_LANE_GROUP],
    });
  }
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
