import { isFastTestRuntimeEnv } from "../../../infra/env.js";

type SwarmLaunch = {
  start: () => Promise<void>;
  /** True once failure is durable or the row no longer owns queued work. */
  onStartFailure: (error: unknown) => boolean | Promise<boolean>;
};

type QueuedSwarmRun = {
  runId: string;
  launch?: SwarmLaunch;
  holds: number;
  retryReady: boolean;
};

type SwarmGroupLane = {
  groupId: string;
  limit: number;
  active: Set<string>;
  queue: QueuedSwarmRun[];
  pumpScheduled: boolean;
};

const lanes = new Map<string, SwarmGroupLane>();
const runLocations = new Map<
  string,
  | { lane: SwarmGroupLane; state: "active"; item?: QueuedSwarmRun }
  | { lane: SwarmGroupLane; state: "queued"; item: QueuedSwarmRun }
>();

async function startQueuedRun(lane: SwarmGroupLane, item: QueuedSwarmRun, launch: SwarmLaunch) {
  lane.active.add(item.runId);
  runLocations.set(item.runId, { lane, state: "active", item });
  try {
    // Acquiring capacity and invoking launch are one synchronous dispatch boundary.
    await launch.start();
  } catch (error) {
    let failurePersisted = false;
    try {
      failurePersisted = await launch.onStartFailure(error);
    } catch {
      // A durable queued row still owns this work; retry after a short backoff.
    }
    const location = runLocations.get(item.runId);
    if (location?.state !== "active" || location.lane !== lane || location.item !== item) {
      return;
    }
    if (failurePersisted) {
      releaseSwarmRun(item.runId);
      return;
    }
    lane.active.delete(item.runId);
    item.retryReady = false;
    lane.queue.unshift(item);
    runLocations.set(item.runId, { lane, state: "queued", item });
    const timer = setTimeout(
      () => {
        item.retryReady = true;
        pumpLane(lane);
      },
      isFastTestRuntimeEnv() ? 1 : 1_000,
    );
    timer.unref?.();
  }
}

function pumpLane(lane: SwarmGroupLane) {
  if (lane.pumpScheduled) {
    return;
  }
  lane.pumpScheduled = true;
  queueMicrotask(() => {
    lane.pumpScheduled = false;
    while (lanes.get(lane.groupId) === lane && lane.active.size < lane.limit) {
      const next = lane.queue[0];
      if (!next?.launch || !next.retryReady || next.holds > 0) {
        return;
      }
      lane.queue.shift();
      void startQueuedRun(lane, next, next.launch);
    }
  });
}

function ensureLane(params: {
  groupId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
}): SwarmGroupLane {
  const lane = lanes.get(params.groupId) ?? {
    groupId: params.groupId,
    limit: params.maxConcurrent,
    active: new Set<string>(),
    queue: [],
    pumpScheduled: false,
  };
  lanes.set(params.groupId, lane);
  lane.limit = params.maxConcurrent;
  for (const runId of params.activeRunIds) {
    // A live reservation is newer than a restored active snapshot. Reclassifying
    // it here would leave its queue node behind and block FIFO admission.
    if (runLocations.has(runId)) {
      continue;
    }
    lane.active.add(runId);
    runLocations.set(runId, { lane, state: "active" });
  }
  return lane;
}

function deleteLaneIfIdle(lane: SwarmGroupLane): void {
  if (lanes.get(lane.groupId) === lane && lane.active.size === 0 && lane.queue.length === 0) {
    lanes.delete(lane.groupId);
  }
}

/** Reserve FIFO position before asynchronous spawn preparation begins. */
export function reserveSwarmRun(params: {
  groupId: string;
  runId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
}): boolean {
  const lane = ensureLane(params);
  if (runLocations.has(params.runId)) {
    deleteLaneIfIdle(lane);
    return false;
  }
  const item: QueuedSwarmRun = { runId: params.runId, holds: 0, retryReady: true };
  lane.queue.push(item);
  runLocations.set(params.runId, { lane, state: "queued", item });
  return true;
}

/** Attach launch work to an existing FIFO reservation. */
export function activateSwarmRun(params: {
  groupId: string;
  runId: string;
  start: () => Promise<void>;
  onStartFailure: (error: unknown) => boolean | Promise<boolean>;
}): void {
  const location = runLocations.get(params.runId);
  if (!location || location.state !== "queued" || location.lane.groupId !== params.groupId) {
    throw new Error(`swarm scheduler reservation missing for run ${params.runId}`);
  }
  const { lane, item } = location;
  item.launch = { start: params.start, onStartFailure: params.onStartFailure };
  pumpLane(lane);
}

export function enqueueSwarmRun(params: {
  groupId: string;
  runId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
  start: () => Promise<void>;
  onStartFailure: (error: unknown) => boolean | Promise<boolean>;
}): void {
  if (
    !reserveSwarmRun({
      groupId: params.groupId,
      runId: params.runId,
      maxConcurrent: params.maxConcurrent,
      activeRunIds: params.activeRunIds,
    })
  ) {
    throw new Error(`swarm scheduler run already exists: ${params.runId}`);
  }
  activateSwarmRun({
    groupId: params.groupId,
    runId: params.runId,
    start: params.start,
    onStartFailure: params.onStartFailure,
  });
}

export function releaseSwarmRun(runId: string): boolean {
  const location = runLocations.get(runId);
  if (!location || location.state !== "active" || !location.lane.active.delete(runId)) {
    return false;
  }
  runLocations.delete(runId);
  pumpLane(location.lane);
  deleteLaneIfIdle(location.lane);
  return true;
}

export function removeQueuedSwarmRun(runId: string): boolean {
  const location = runLocations.get(runId);
  if (!location || location.state !== "queued") {
    return false;
  }
  const index = location.lane.queue.indexOf(location.item);
  if (index < 0) {
    return false;
  }
  location.lane.queue.splice(index, 1);
  runLocations.delete(runId);
  pumpLane(location.lane);
  deleteLaneIfIdle(location.lane);
  return true;
}

/** True only after launch was invoked (or an already-running slot was restored). */
export function isSwarmRunActive(runId: string): boolean {
  return runLocations.get(runId)?.state === "active";
}

/** Holds this exact reservation, including preparation that has not activated yet. */
export function holdQueuedSwarmRun(runId: string) {
  const location = runLocations.get(runId);
  if (location?.state !== "queued") {
    return undefined;
  }
  const { lane, item } = location;
  item.holds += 1;
  let released = false;
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      item.holds -= 1;
      pumpLane(lane);
    },
    withdraw() {
      // A retained durable kill may withdraw only its never-started reservation.
      // Reused IDs and lanes must not inherit an older cancellation scope.
      return !released && runLocations.get(runId) === location && removeQueuedSwarmRun(runId);
    },
  };
}

const testing = {
  reset() {
    lanes.clear();
    runLocations.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.swarmSchedulerTestApi")] = {
    testing,
  };
}
