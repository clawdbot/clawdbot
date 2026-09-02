// Shared command-queue runtime state, split out of command-queue.ts so the
// capacity-group policy can read lane state without importing the queue itself.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CommandQueueEnqueueOptions } from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";

export type CommandLaneTaskMarker = Readonly<{
  lane: string;
  taskId: number;
  generation: number;
}>;

export type QueuePriority = -1 | 0 | 1;

export type QueueEntry = {
  queued?: true;
  task: (marker: CommandLaneTaskMarker) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  priority: QueuePriority;
  warnAfterMs: number;
  queuedAheadAtEnqueue: number;
  activeAheadAtEnqueue: number;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  taskTimeoutSubscribe?: CommandQueueEnqueueOptions["taskTimeoutSubscribe"];
  taskTimeoutAbortSignal?: AbortSignal;
  taskTimeoutAbortGraceMs?: number;
  taskTimeoutReleaseSignal?: AbortSignal;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type QueueRing = {
  entries: Array<QueueEntry | undefined>;
  head: number;
  length: number;
};

/** Three fixed FIFO rings, one for each supported priority. */
type LaneQueue = {
  background: QueueRing;
  normal: QueueRing;
  foreground: QueueRing;
  length: number;
};

export type LaneState = {
  lane: string;
  queue: LaneQueue;
  activeTaskIds: Set<number>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
};

const INITIAL_QUEUE_RING_CAPACITY = 16;

function createQueueRing(): QueueRing {
  return { entries: [], head: 0, length: 0 };
}

export function createLaneQueue(): LaneQueue {
  return {
    background: createQueueRing(),
    normal: createQueueRing(),
    foreground: createQueueRing(),
    length: 0,
  };
}

function getPriorityRing(queue: LaneQueue, priority: QueuePriority): QueueRing {
  switch (priority) {
    case 1:
      return queue.foreground;
    case -1:
      return queue.background;
    default:
      return queue.normal;
  }
}

function appendQueueRing(ring: QueueRing, entry: QueueEntry): void {
  if (ring.length === ring.entries.length) {
    const nextCapacity = Math.max(INITIAL_QUEUE_RING_CAPACITY, ring.length * 2);
    // oxlint-disable-next-line unicorn/no-new-array -- Reserve sparse capacity; head and length delimit occupied slots.
    const nextEntries = new Array<QueueEntry | undefined>(nextCapacity);
    for (let index = 0; index < ring.length; index += 1) {
      nextEntries[index] = ring.entries[(ring.head + index) % ring.entries.length];
    }
    ring.entries = nextEntries;
    ring.head = 0;
  }
  ring.entries[(ring.head + ring.length) % ring.entries.length] = entry;
  ring.length += 1;
}

function peekQueueRing(ring: QueueRing): QueueEntry | undefined {
  return ring.length > 0 ? ring.entries[ring.head] : undefined;
}

function dequeueQueueRing(ring: QueueRing): QueueEntry | undefined {
  if (ring.length === 0) {
    return undefined;
  }
  const entry = ring.entries[ring.head];
  ring.entries[ring.head] = undefined;
  ring.length -= 1;
  if (ring.length === 0) {
    // Release a drained burst's backing allocation rather than retaining each
    // lane's historical high-water capacity indefinitely.
    ring.entries = [];
    ring.head = 0;
  } else {
    ring.head = (ring.head + 1) % ring.entries.length;
  }
  return entry;
}

/** Append to one of three fixed priority FIFOs and return the queued work ahead. */
export function enqueueLaneQueue(queue: LaneQueue, entry: QueueEntry): number {
  const ring = getPriorityRing(queue, entry.priority);
  const queuedAhead =
    ring.length +
    (entry.priority <= 0 ? queue.foreground.length : 0) +
    (entry.priority < 0 ? queue.normal.length : 0);
  entry.queued = true;
  appendQueueRing(ring, entry);
  queue.length += 1;
  return queuedAhead;
}

export function peekLaneQueue(queue: LaneQueue): QueueEntry | undefined {
  return (
    peekQueueRing(queue.foreground) ??
    peekQueueRing(queue.normal) ??
    peekQueueRing(queue.background)
  );
}

export function dequeueLaneQueue(queue: LaneQueue): QueueEntry | undefined {
  const entry =
    dequeueQueueRing(queue.foreground) ??
    dequeueQueueRing(queue.normal) ??
    dequeueQueueRing(queue.background);
  if (entry) {
    delete entry.queued;
    queue.length -= 1;
  }
  return entry;
}

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
    queueFormatVersion: 1,
  }));
  if (!state.nextQueueSequence) {
    state.nextQueueSequence = 1;
  }
  // SIGUSR1 restarts can preserve the singleton created by the shipped array-backed queue.
  // Convert it once so steady-state state reads do not rescan every queued entry.
  if (state.queueFormatVersion !== 1) {
    let maxQueueSequence = state.nextQueueSequence - 1;
    type LegacyQueueEntry = QueueEntry & {
      activeAheadAtEnqueue?: number;
      priority?: number;
      queuedAheadAtEnqueue?: number;
      sequence?: number;
    };
    type LegacyLaneState = Omit<LaneState, "queue"> & {
      queue: LaneQueue | LegacyQueueEntry[];
    };
    for (const lane of state.lanes.values() as Iterable<LegacyLaneState>) {
      if (!Array.isArray(lane.queue)) {
        continue;
      }
      const legacyQueue = lane.queue;
      const queue = createLaneQueue();
      for (const [index, entry] of legacyQueue.entries()) {
        entry.priority = entry.priority === 1 || entry.priority === -1 ? entry.priority : 0;
        if (typeof entry.sequence !== "number") {
          entry.sequence = state.nextQueueSequence++;
        }
        maxQueueSequence = Math.max(maxQueueSequence, entry.sequence);
        if (typeof entry.queuedAheadAtEnqueue !== "number") {
          entry.queuedAheadAtEnqueue = index;
        }
        if (typeof entry.activeAheadAtEnqueue !== "number") {
          entry.activeAheadAtEnqueue = lane.activeTaskIds.size;
        }
        enqueueLaneQueue(queue, entry);
      }
      lane.queue = queue;
    }
    if (state.nextQueueSequence <= maxQueueSequence) {
      state.nextQueueSequence = maxQueueSequence + 1;
    }
    state.queueFormatVersion = 1;
  }
  return state;
}

export function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}
