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
  limit: number;
  active: Set<string>;
  queue: QueuedSwarmRun[];
};

const lanes = new Map<string, SwarmGroupLane>();

function startQueuedRun(lane: SwarmGroupLane, item: QueuedSwarmRun) {
  const start = item.start;
  const onStartFailure = item.onStartFailure;
  if (!start || !onStartFailure) {
    return;
  }
  lane.active.add(item.runId);
  queueMicrotask(() => {
    void start().catch(async (error: unknown) => {
      let failurePersisted = false;
      try {
        failurePersisted = await onStartFailure(error);
      } catch {
        // A durable queued row still owns this work; retry after a short backoff.
      }
      if (failurePersisted) {
        releaseSwarmRun(item.runId);
        return;
      }
      lane.active.delete(item.runId);
      item.retryReady = false;
      lane.queue.unshift(item);
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
    limit: params.maxConcurrent,
    active: new Set<string>(),
    queue: [],
  };
  lanes.set(params.groupId, lane);
  lane.limit = params.maxConcurrent;
  for (const runId of params.activeRunIds) {
    lane.active.add(runId);
  }
  return lane;
}

/** Reserve FIFO position before asynchronous spawn preparation begins. */
export function reserveSwarmRun(params: {
  groupId: string;
  runId: string;
  maxConcurrent: number;
  activeRunIds: readonly string[];
}): boolean {
  const lane = ensureLane(params);
  if (lane.active.has(params.runId) || lane.queue.some((item) => item.runId === params.runId)) {
    return false;
  }
  lane.queue.push({ runId: params.runId, ready: false, retryReady: true });
  return true;
}

/** Attach launch work to an existing FIFO reservation. */
export function activateSwarmRun(params: {
  groupId: string;
  runId: string;
  start: () => Promise<void>;
  onStartFailure: (error: unknown) => boolean | Promise<boolean>;
}): "started" | "queued" {
  const lane = lanes.get(params.groupId);
  const item = lane?.queue.find((candidate) => candidate.runId === params.runId);
  if (!lane || !item) {
    throw new Error(`swarm scheduler reservation missing for run ${params.runId}`);
  }
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
  for (const [groupId, lane] of lanes) {
    if (!lane.active.delete(runId)) {
      continue;
    }
    pumpLane(lane);
    if (lane.active.size === 0 && lane.queue.length === 0) {
      lanes.delete(groupId);
    }
    return true;
  }
  return false;
}

export function removeQueuedSwarmRun(runId: string): boolean {
  for (const [groupId, lane] of lanes) {
    const index = lane.queue.findIndex((item) => item.runId === runId);
    if (index < 0) {
      continue;
    }
    lane.queue.splice(index, 1);
    pumpLane(lane);
    if (lane.active.size === 0 && lane.queue.length === 0) {
      lanes.delete(groupId);
    }
    return true;
  }
  return false;
}

export function isSwarmRunQueued(runId: string): boolean {
  for (const lane of lanes.values()) {
    if (lane.queue.some((item) => item.runId === runId)) {
      return true;
    }
  }
  return false;
}

const testing = {
  reset() {
    lanes.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.swarmSchedulerTestApi")] = {
    testing,
  };
}
