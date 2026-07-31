import {
  enableSessionSuspensionTimersForGatewayStart,
  getCleanupSuspendedLaneIdsForGatewayPublication,
} from "../agents/session-suspension.js";
// Gateway command-lane concurrency applier.
// Pushes config-derived agent/cron limits into the process command queue.
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

type GatewayLaneConcurrency = {
  cron: number;
  hookDispatch: number;
  main: number;
  subagent: number;
};

/** Hook agent runs serialize against each other; the lane is one-wide by design. */
const HOOK_DISPATCH_LANE_CONCURRENCY = 1;

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  return {
    cron: resolveCronMaxConcurrentRuns(),
    hookDispatch: HOOK_DISPATCH_LANE_CONCURRENCY,
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
  // Cron isolated agent turns remap inner LLM work to this lane.
  if (!suspendedLaneIds.has(CommandLane.CronNested)) {
    setCommandLaneConcurrency(CommandLane.CronNested, concurrency.cron);
  }
  // Hook agent runs. One-wide: the guarantee is that a hook can always start
  // under cron saturation, not that hooks run concurrently with each other.
  // Aggregate capacity across this lane and `cron-nested` is bounded by their
  // shared group, so this does not add a slot outside the cron budget.
  if (!suspendedLaneIds.has(CommandLane.HookDispatch)) {
    setCommandLaneConcurrency(CommandLane.HookDispatch, concurrency.hookDispatch);
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
