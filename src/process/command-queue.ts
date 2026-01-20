import { CommandLane } from "./lanes.js";
import { diagnosticLogger as diag, logLaneDequeue, logLaneEnqueue } from "../logging/diagnostic.js";

// Minimal in-process queue to serialize command executions.
// Default lane ("main") preserves the existing behavior. Additional lanes allow
// low-risk parallelism (e.g. cron jobs) without interleaving stdin / logs for
// the main auto-reply workflow.

type QueueEntry = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  active: number;
  maxConcurrent: number;
  draining: boolean;
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) return existing;
  const created: LaneState = {
    lane,
    queue: [],
    active: 0,
    maxConcurrent: 1,
    draining: false,
  };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) return;
  state.draining = true;

  const pump = () => {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry;
      const waitedMs = Date.now() - entry.enqueuedAt;
      if (waitedMs >= entry.warnAfterMs) {
        entry.onWait?.(waitedMs, state.queue.length);
        diag.warn(
          `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${state.queue.length}`,
        );
      }
      logLaneDequeue(lane, waitedMs, state.queue.length);
      state.active += 1;
      void (async () => {
        const startTime = Date.now();
        try {
          const result = await entry.task();
          state.active -= 1;
          diag.debug(
            `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.active} queued=${state.queue.length}`,
          );
          pump();
          entry.resolve(result);
        } catch (err) {
          state.active -= 1;
          diag.error(
            `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
          );
          pump();
          entry.reject(err);
        }
      })();
    }
    state.draining = false;
  };

  pump();
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  const cleaned = lane.trim() || CommandLane.Main;
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
    });
    logLaneEnqueue(cleaned, state.queue.length + state.active);
    drainLane(cleaned);
  });
}

export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = lane.trim() || CommandLane.Main;
  const state = lanes.get(resolved);
  if (!state) return 0;
  return state.queue.length + state.active;
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of lanes.values()) {
    total += s.queue.length + s.active;
  }
  return total;
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = lane.trim() || CommandLane.Main;
  const state = lanes.get(cleaned);
  if (!state) return 0;
  const removed = state.queue.length;
  state.queue.length = 0;
  return removed;
}
