/**
 * Per-room group chat history tracking for Matrix.
 *
 * Maintains a shared per-room message queue and per-(agentId, roomId) watermarks so
 * each agent independently tracks which messages it has already consumed. This design
 * lets multiple agents in the same room see independent history windows:
 *
 * - dev replies to @dev msgB (watermark advances to B) → room queue still has [A, B]
 * - spark replies to @spark msgC → spark watermark starts at 0 and sees [A, B, C]
 *
 * Race-condition safety: the watermark only advances to the snapshot index taken at
 * dispatch time, NOT to the queue's end at reply time.  Messages that land in the queue
 * while the agent is processing stay visible to the next trigger for that agent.
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

/** Maximum entries retained per room (hard cap to bound memory). */
const DEFAULT_MAX_QUEUE_SIZE = 200;
/** Maximum number of rooms to retain queues for (FIFO eviction beyond this). */
const DEFAULT_MAX_ROOM_QUEUES = 1000;
/** Maximum number of (agentId, roomId) watermark entries to retain. */
const MAX_WATERMARK_ENTRIES = 5000;
/** Maximum prepared trigger snapshots retained per room for retry reuse. */
const MAX_PREPARED_TRIGGER_ENTRIES = 500;

export type { HistoryEntry };

type HistorySnapshotToken = {
  snapshotIdx: number;
  queueGeneration: number;
};

type PreparedTriggerResult = {
  history: HistoryEntry[];
} & HistorySnapshotToken;

type RoomHistoryTracker = {
  /**
   * Record a non-trigger message for future context.
   * Call this when a room message arrives but does not mention the bot.
   */
  recordPending: (roomId: string, entry: HistoryEntry) => void;

  /**
   * Capture pending history and append the trigger as one idempotent operation.
   * Retries of the same Matrix event reuse the original prepared history window.
   */
  prepareTrigger: (
    agentId: string,
    roomId: string,
    limit: number,
    entry: HistoryEntry,
  ) => PreparedTriggerResult;

  /**
   * Advance the agent's watermark to the snapshot index returned by prepareTrigger
   * (or the lower-level recordTrigger helper used in tests).
   * Only messages appended after that snapshot remain visible on the next trigger.
   */
  consumeHistory: (
    agentId: string,
    roomId: string,
    snapshot: HistorySnapshotToken,
    messageId?: string,
  ) => void;
};

type RoomHistoryTrackerTestApi = RoomHistoryTracker & {
  /**
   * Test-only helper for inspecting pending room history directly.
   */
  getPendingHistory: (agentId: string, roomId: string, limit: number) => HistoryEntry[];

  /**
   * Test-only helper for manually appending a trigger entry and snapshot index.
   */
  recordTrigger: (roomId: string, entry: HistoryEntry) => HistorySnapshotToken;
};

type RoomQueue = {
  entries: HistoryEntry[];
  /** Absolute index of entries[0] — increases as old entries are trimmed. */
  baseIndex: number;
  generation: number;
  preparedTriggers: Map<string, PreparedTriggerResult>;
};

function createRoomHistoryTrackerInternal(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTrackerTestApi {
  const roomQueues = new Map<string, RoomQueue>();
  /** Maps `${agentId}:${roomId}` → absolute consumed-up-to index */
  const agentWatermarks = new Map<string, number>();
  let nextQueueGeneration = 1;

  function clearRoomWatermarks(roomId: string): void {
    const roomSuffix = `:${roomId}`;
    for (const key of agentWatermarks.keys()) {
      if (key.endsWith(roomSuffix)) {
        agentWatermarks.delete(key);
      }
    }
  }

  function getOrCreateQueue(roomId: string): RoomQueue {
    let queue = roomQueues.get(roomId);
    if (!queue) {
      queue = {
        entries: [],
        baseIndex: 0,
        generation: nextQueueGeneration++,
        preparedTriggers: new Map(),
      };
      roomQueues.set(roomId, queue);
      // FIFO eviction to prevent unbounded growth across many rooms
      if (roomQueues.size > maxRoomQueues) {
        const oldest = roomQueues.keys().next().value;
        if (oldest !== undefined) {
          roomQueues.delete(oldest);
          clearRoomWatermarks(oldest);
        }
      }
    }
    return queue;
  }

  function appendToQueue(queue: RoomQueue, entry: HistoryEntry): HistorySnapshotToken {
    queue.entries.push(entry);
    if (queue.entries.length > maxQueueSize) {
      const overflow = queue.entries.length - maxQueueSize;
      queue.entries.splice(0, overflow);
      queue.baseIndex += overflow;
    }
    return {
      snapshotIdx: queue.baseIndex + queue.entries.length,
      queueGeneration: queue.generation,
    };
  }

  function wmKey(agentId: string, roomId: string): string {
    return `${agentId}:${roomId}`;
  }

  function preparedTriggerKey(agentId: string, messageId?: string): string | null {
    if (!messageId?.trim()) {
      return null;
    }
    return `${agentId}:${messageId.trim()}`;
  }

  function rememberWatermark(key: string, snapshotIdx: number): void {
    const nextSnapshotIdx = Math.max(agentWatermarks.get(key) ?? 0, snapshotIdx);
    if (agentWatermarks.has(key)) {
      // Refresh insertion order so capped-map eviction removes the stalest pair, not an active one.
      agentWatermarks.delete(key);
    }
    agentWatermarks.set(key, nextSnapshotIdx);
    if (agentWatermarks.size > maxWatermarkEntries) {
      const oldest = agentWatermarks.keys().next().value;
      if (oldest !== undefined) {
        agentWatermarks.delete(oldest);
      }
    }
  }

  function rememberPreparedTrigger(
    queue: RoomQueue,
    retryKey: string,
    prepared: PreparedTriggerResult,
  ): PreparedTriggerResult {
    if (queue.preparedTriggers.has(retryKey)) {
      // Refresh insertion order so capped eviction keeps actively retried events hot.
      queue.preparedTriggers.delete(retryKey);
    }
    queue.preparedTriggers.set(retryKey, prepared);
    if (queue.preparedTriggers.size > maxPreparedTriggerEntries) {
      const oldest = queue.preparedTriggers.keys().next().value;
      if (oldest !== undefined) {
        queue.preparedTriggers.delete(oldest);
      }
    }
    return prepared;
  }

  function computePendingHistory(
    queue: RoomQueue,
    agentId: string,
    roomId: string,
    limit: number,
  ): HistoryEntry[] {
    if (limit <= 0 || queue.entries.length === 0) {
      return [];
    }
    const wm = agentWatermarks.get(wmKey(agentId, roomId)) ?? 0;
    // startAbs: the first absolute index the agent hasn't seen yet
    const startAbs = Math.max(wm, queue.baseIndex);
    const startRel = startAbs - queue.baseIndex;
    const available = queue.entries.slice(startRel);
    return available.length > limit ? available.slice(-limit) : available;
  }

  return {
    recordPending(roomId, entry) {
      const queue = getOrCreateQueue(roomId);
      appendToQueue(queue, entry);
    },

    getPendingHistory(agentId, roomId, limit) {
      const queue = roomQueues.get(roomId);
      if (!queue) {
        return [];
      }
      return computePendingHistory(queue, agentId, roomId, limit);
    },

    recordTrigger(roomId, entry) {
      const queue = getOrCreateQueue(roomId);
      return appendToQueue(queue, entry);
    },

    prepareTrigger(agentId, roomId, limit, entry) {
      const queue = getOrCreateQueue(roomId);
      const retryKey = preparedTriggerKey(agentId, entry.messageId);
      if (retryKey) {
        const prepared = queue.preparedTriggers.get(retryKey);
        if (prepared) {
          return rememberPreparedTrigger(queue, retryKey, prepared);
        }
      }
      const prepared = {
        history: computePendingHistory(queue, agentId, roomId, limit),
        ...appendToQueue(queue, entry),
      };
      if (retryKey) {
        return rememberPreparedTrigger(queue, retryKey, prepared);
      }
      return prepared;
    },

    consumeHistory(agentId, roomId, snapshot, messageId) {
      const key = wmKey(agentId, roomId);
      const queue = roomQueues.get(roomId);
      if (!queue) {
        // The room was evicted while this trigger was in flight. Keep eviction authoritative
        // so a late completion cannot recreate a stale watermark against a fresh queue.
        agentWatermarks.delete(key);
        return;
      }
      if (queue.generation !== snapshot.queueGeneration) {
        // The room was evicted and recreated before this trigger completed. Reject the stale
        // snapshot so it cannot advance or erase state for the new queue generation.
        return;
      }
      // Monotone write: never regress an already-advanced watermark.
      // Guards against out-of-order completion when two triggers for the same
      // (agentId, roomId) are in-flight concurrently.
      rememberWatermark(key, snapshot.snapshotIdx);
      const retryKey = preparedTriggerKey(agentId, messageId);
      if (queue && retryKey) {
        queue.preparedTriggers.delete(retryKey);
      }
    },
  };
}

export function createRoomHistoryTracker(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTracker {
  const tracker = createRoomHistoryTrackerInternal(
    maxQueueSize,
    maxRoomQueues,
    maxWatermarkEntries,
    maxPreparedTriggerEntries,
  );
  return {
    recordPending: tracker.recordPending,
    prepareTrigger: tracker.prepareTrigger,
    consumeHistory: tracker.consumeHistory,
  };
}

export function createRoomHistoryTrackerForTests(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTrackerTestApi {
  return createRoomHistoryTrackerInternal(
    maxQueueSize,
    maxRoomQueues,
    maxWatermarkEntries,
    maxPreparedTriggerEntries,
  );
}
