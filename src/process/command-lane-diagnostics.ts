// Bounded diagnostics composition over the command queue's lane totals.
// Static lanes get full snapshots; per-session (dynamic) lanes collapse into
// one aggregate so a saturation snapshot can never become an unbounded payload.
import {
  type CommandLaneSnapshot,
  getCommandLaneSnapshot,
  listCommandLaneTotals,
} from "./command-queue.js";
import { STATIC_COMMAND_LANES } from "./lanes.js";

type DynamicCommandLaneSummary = {
  laneCount: number;
  activeCount: number;
  queuedCount: number;
  queuedLaneCount: number;
};

const STATIC_COMMAND_LANE_SET: ReadonlySet<string> = new Set(STATIC_COMMAND_LANES);

export function getCommandLaneDiagnostics(): {
  lanes: CommandLaneSnapshot[];
  dynamic: DynamicCommandLaneSummary | null;
} {
  const lanes = [...STATIC_COMMAND_LANES]
    .toSorted()
    .map((lane) => getCommandLaneSnapshot(lane))
    // Disabled lanes disappear only once their outstanding work has cleared.
    .filter((lane) => lane.maxConcurrent > 0 || lane.activeCount > 0 || lane.queuedCount > 0);
  const dynamic: DynamicCommandLaneSummary = {
    laneCount: 0,
    activeCount: 0,
    queuedCount: 0,
    queuedLaneCount: 0,
  };
  for (const totals of listCommandLaneTotals()) {
    if (STATIC_COMMAND_LANE_SET.has(totals.lane)) {
      continue;
    }
    dynamic.laneCount += 1;
    dynamic.activeCount += totals.activeCount;
    dynamic.queuedCount += totals.queuedCount;
    if (totals.queuedCount > 0) {
      dynamic.queuedLaneCount += 1;
    }
  }
  return { lanes, dynamic: dynamic.laneCount > 0 ? dynamic : null };
}
