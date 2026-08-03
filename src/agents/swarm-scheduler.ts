import { isFastTestRuntimeEnv } from "../infra/env.js";

type QueuedSwarmRun = {
  runId: string;
  start?: () => Promise<void>;
  /** True once failure is durable or the row no longer owns queued work. */
  onStartFailure?: (error: unknown) => boolean | Promise<boolean>;
  ready: boolean;
  retryReady: boolean;
};

type SwarmGroupLane = {
  groupId: string;
  limit: number;
  active: Set<string>;
  queue: QueuedSwarmRun[];
};

const lanes = new Map<string, SwarmGroupLane>();
const runLocations = new Map<
  string,
  | { lane: SwarmGroupLane; state: "active"; item?: QueuedSwarmRun }
  | { lane: SwarmGroupLane; state: "queued"; item: QueuedSwarmRun }
>();

function startQueuedRun(lane: SwarmGroupLane, item: QueuedSwarmRun) {
  const start = item.start;
  const onStartFailure = item.onStartFailure;
  if (!start || !onStartFailure) {
    return;
  }
  lane.active.add(item.runId);
  runLocations.set(item.runId, { lane, state: "active", item });
  queueMicrotask(() => {
    void start().catch(async (error: unknown) => {
      let failurePersisted = false;
      try {
        failurePersisted = await onStartFailure(error);
      } catch {
        // A durable queued row still owns this work; retry after a short backoff.
      }
      const location = runLocations.get(item.runId);
      if (
        !location ||
        location.state !== "active" ||
        location.lane !== lane ||
        location.item !== item
      ) {
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
    });
  });
}

function pumpLane(lane: SwarmGroupLane) {
  while (lane.active.size < lane.limit) {
    const next = lane.queue[0];
    if (!next || !next.ready || !next.retryReady) {
      return;
    }
    lane.queue.shift();
    startQueuedRun(lane, next);
  }
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
  const item = { runId: params.runId, ready: false, retryReady: true };
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
}): "started" | "queued" {
  const location = runLocations.get(params.runId);
  if (!location || location.state !== "queued" || location.lane.groupId !== params.groupId) {
    throw new Error(`swarm scheduler reservation missing for run ${params.runId}`);
  }
  const { lane, item } = location;
  item.start = params.start;
  item.onStartFailure = params.onStartFailure;
  item.ready = true;
  pumpLane(lane);
  return lane.active.has(item.runId) ? "started" : "queued";
}

export function enqueueSwarmRun(params: {
  groupId: string;
  runId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
  start: () => Promise<void>;
  onStartFailure: (error: unknown) => boolean | Promise<boolean>;
}): "started" | "queued" {
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
  return activateSwarmRun({
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

export function isSwarmRunQueued(runId: string): boolean {
  return runLocations.get(runId)?.state === "queued";
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
