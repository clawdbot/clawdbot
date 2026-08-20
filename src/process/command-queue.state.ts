// Shared command-queue runtime state, split out of command-queue.ts so the
// capacity-group policy can read lane state without importing the queue itself.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { CommandLane } from "./lanes.js";

export type CommandLaneTaskMarker = Readonly<{
  lane: string;
  taskId: number;
  generation: number;
}>;

export type QueueEntry = {
  task: (marker: CommandLaneTaskMarker) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  priority: number;
  warnAfterMs: number;
  queuedAheadAtEnqueue: number;
  activeAheadAtEnqueue: number;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  taskTimeoutReleaseSignal?: AbortSignal;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

export type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

export function getQueueState() {
  const state = resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
    lanes: new Map<string, LaneState>(),
    nextTaskId: 1,
    nextQueueSequence: 1,
  }));
  if (!state.nextQueueSequence) {
    state.nextQueueSequence = 1;
  }
  let maxQueueSequence = state.nextQueueSequence - 1;
  for (const lane of state.lanes.values()) {
    for (const [index, entry] of (
      lane.queue as Array<
        QueueEntry & {
          activeAheadAtEnqueue?: number;
          priority?: number;
          queuedAheadAtEnqueue?: number;
          sequence?: number;
        }
      >
    ).entries()) {
      if (typeof entry.priority !== "number") {
        entry.priority = 0;
      }
      if (typeof entry.sequence !== "number") {
        entry.sequence = state.nextQueueSequence++;
      } else {
        maxQueueSequence = Math.max(maxQueueSequence, entry.sequence);
      }
      if (typeof entry.queuedAheadAtEnqueue !== "number") {
        entry.queuedAheadAtEnqueue = index;
      }
      if (typeof entry.activeAheadAtEnqueue !== "number") {
        entry.activeAheadAtEnqueue = lane.activeTaskIds.size;
      }
    }
  }
  if (state.nextQueueSequence <= maxQueueSequence) {
    state.nextQueueSequence = maxQueueSequence + 1;
  }
  return state;
}

export function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}
