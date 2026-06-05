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
 *
 * Thread-scoped history uses a separate sub-queue per Matrix thread root. Main-room
 * history and thread history must not share watermarks or pending context.
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
/** Maximum thread queues retained per room (FIFO eviction beyond this). */
const MAX_THREAD_QUEUES_PER_ROOM = 200;

export type { HistoryEntry };

type HistorySnapshotToken = {
  snapshotIdx: number;
  queueGeneration: number;
};

export type ReservedHistorySlot = HistorySnapshotToken & {
  slotIdx: number;
  watermarkIdx?: number;
};

type QueuedHistoryEntry = HistoryEntry & {
  discarded?: true;
  reserved?: true;
  consumedBy?: Set<string>;
};

type PreparedTriggerResult = {
  history: HistoryEntry[];
} & HistorySnapshotToken;

type RoomHistoryTracker = {
  /**
   * Record a non-trigger message for future context.
   * Call this when a room message arrives but does not mention the bot.
   */
  recordPending: (roomId: string, entry: HistoryEntry, threadRootId?: string) => void;

  /** Reserve an arrival-order slot for slow preflight work that finishes later. */
  reservePending: (
    agentId: string,
    roomId: string,
    entry: HistoryEntry,
    threadRootId?: string,
  ) => ReservedHistorySlot;

  /** Replace a reserved slot with its final non-trigger history entry. */
  finalizePending: (
    roomId: string,
    slot: ReservedHistorySlot,
    entry: HistoryEntry,
    threadRootId?: string,
  ) => void;

  /** Remove a reserved slot without changing later absolute indexes. */
  discardPending: (roomId: string, slot: ReservedHistorySlot, threadRootId?: string) => void;

  /**
   * Capture pending history and append the trigger as one idempotent operation.
   * Retries of the same Matrix event reuse the original prepared history window.
   */
  prepareTrigger: (
    agentId: string,
    roomId: string,
    limit: number,
    entry: HistoryEntry,
    threadRootId?: string,
  ) => PreparedTriggerResult;

  /** Prepare a trigger using a previously reserved arrival-order slot. */
  prepareReservedTrigger: (
    agentId: string,
    roomId: string,
    limit: number,
    slot: ReservedHistorySlot,
    entry: HistoryEntry,
    threadRootId?: string,
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
    threadRootId?: string,
  ) => void;
};

type RoomHistoryTrackerTestApi = RoomHistoryTracker & {
  /**
   * Test-only helper for inspecting pending room history directly.
   */
  getPendingHistory: (
    agentId: string,
    roomId: string,
    limit: number,
    threadRootId?: string,
  ) => HistoryEntry[];

  /**
   * Test-only helper for manually appending a trigger entry and snapshot index.
   */
  recordTrigger: (
    roomId: string,
    entry: HistoryEntry,
    threadRootId?: string,
  ) => HistorySnapshotToken;
};

type HistoryQueue = {
  entries: QueuedHistoryEntry[];
  /** Absolute index of entries[0] — increases as old entries are trimmed. */
  baseIndex: number;
  generation: number;
  preparedTriggers: Map<string, PreparedTriggerResult>;
};

type RoomQueue = HistoryQueue & {
  threadQueues: Map<string, HistoryQueue>;
};

function createRoomHistoryTrackerInternal(
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  maxRoomQueues = DEFAULT_MAX_ROOM_QUEUES,
  maxWatermarkEntries = MAX_WATERMARK_ENTRIES,
  maxPreparedTriggerEntries = MAX_PREPARED_TRIGGER_ENTRIES,
): RoomHistoryTrackerTestApi {
  const roomQueues = new Map<string, RoomQueue>();
  /** Maps `{agentId, roomId, scope}` → absolute consumed-up-to index */
  const agentWatermarks = new Map<string, number>();
  let nextQueueGeneration = 1;

  function clearRoomWatermarks(roomId: string): void {
    for (const key of agentWatermarks.keys()) {
      const parsed = JSON.parse(key) as { roomId?: string } | null;
      if (parsed?.roomId === roomId) {
        agentWatermarks.delete(key);
      }
    }
  }

  function clearThreadWatermarks(roomId: string, threadRootId: string): void {
    for (const key of agentWatermarks.keys()) {
      const parsed = JSON.parse(key) as { roomId?: string; scope?: string } | null;
      if (parsed?.roomId === roomId && parsed.scope === threadRootId) {
        agentWatermarks.delete(key);
      }
    }
  }

  function createHistoryQueue(): HistoryQueue {
    return {
      entries: [],
      baseIndex: 0,
      generation: nextQueueGeneration++,
      preparedTriggers: new Map(),
    };
  }

  function getOrCreateQueue(roomId: string): RoomQueue {
    let queue = roomQueues.get(roomId);
    if (!queue) {
      queue = {
        ...createHistoryQueue(),
        threadQueues: new Map(),
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

  function getOrCreateThreadQueue(
    roomId: string,
    roomQueue: RoomQueue,
    threadRootId: string,
  ): HistoryQueue {
    let queue = roomQueue.threadQueues.get(threadRootId);
    if (!queue) {
      queue = createHistoryQueue();
      roomQueue.threadQueues.set(threadRootId, queue);
      if (roomQueue.threadQueues.size > MAX_THREAD_QUEUES_PER_ROOM) {
        const oldest = roomQueue.threadQueues.keys().next().value;
        if (oldest !== undefined) {
          roomQueue.threadQueues.delete(oldest);
          clearThreadWatermarks(roomId, oldest);
        }
      }
    }
    return queue;
  }

  function getScopedQueue(roomId: string, threadRootId?: string): HistoryQueue {
    const roomQueue = getOrCreateQueue(roomId);
    return threadRootId ? getOrCreateThreadQueue(roomId, roomQueue, threadRootId) : roomQueue;
  }

  function findScopedQueue(roomId: string, threadRootId?: string): HistoryQueue | undefined {
    const roomQueue = roomQueues.get(roomId);
    if (!roomQueue) {
      return undefined;
    }
    return threadRootId ? roomQueue.threadQueues.get(threadRootId) : roomQueue;
  }

  function appendToQueue(queue: HistoryQueue, entry: QueuedHistoryEntry): HistorySnapshotToken {
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

  function wmKey(agentId: string, roomId: string, threadRootId?: string): string {
    return JSON.stringify({
      agentId,
      roomId,
      scope: threadRootId ?? "main",
    });
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

  function markConsumedAfterReservedGap(
    queue: HistoryQueue,
    key: string,
    firstReservedRel: number,
    snapshotIdx: number,
  ): void {
    const endRel = Math.min(snapshotIdx - queue.baseIndex, queue.entries.length);
    for (let rel = firstReservedRel + 1; rel < endRel; rel += 1) {
      const entry = queue.entries[rel];
      if (!entry || entry.reserved || entry.discarded) {
        continue;
      }
      entry.consumedBy ??= new Set<string>();
      entry.consumedBy.add(key);
    }
  }

  function rememberPreparedTrigger(
    queue: HistoryQueue,
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
    queue: HistoryQueue,
    agentId: string,
    roomId: string,
    limit: number,
    endAbsExclusive = queue.baseIndex + queue.entries.length,
    startAbsOverride?: number,
    threadRootId?: string,
  ): HistoryEntry[] {
    if (limit <= 0 || queue.entries.length === 0) {
      return [];
    }
    const wm = startAbsOverride ?? agentWatermarks.get(wmKey(agentId, roomId, threadRootId)) ?? 0;
    // startAbs: the first absolute index the agent hasn't seen yet
    const startAbs = Math.max(wm, queue.baseIndex);
    const startRel = startAbs - queue.baseIndex;
    const endRel = Math.max(
      startRel,
      Math.min(endAbsExclusive - queue.baseIndex, queue.entries.length),
    );
    const available = queue.entries
      .slice(startRel, endRel)
      .filter(
        (entry) =>
          !entry.discarded &&
          !entry.reserved &&
          !entry.consumedBy?.has(wmKey(agentId, roomId, threadRootId)),
      );
    return available.length > limit ? available.slice(-limit) : available;
  }

  function prepareTriggerInternal(
    agentId: string,
    roomId: string,
    limit: number,
    entry: HistoryEntry,
    threadRootId?: string,
  ): PreparedTriggerResult {
    const queue = getScopedQueue(roomId, threadRootId);
    const retryKey = preparedTriggerKey(agentId, entry.messageId);
    if (retryKey) {
      const prepared = queue.preparedTriggers.get(retryKey);
      if (prepared) {
        return rememberPreparedTrigger(queue, retryKey, prepared);
      }
    }
    const prepared = {
      history: computePendingHistory(
        queue,
        agentId,
        roomId,
        limit,
        undefined,
        undefined,
        threadRootId,
      ),
      ...appendToQueue(queue, entry),
    };
    if (retryKey) {
      return rememberPreparedTrigger(queue, retryKey, prepared);
    }
    return prepared;
  }

  return {
    recordPending(roomId, entry, threadRootId) {
      const queue = getScopedQueue(roomId, threadRootId);
      appendToQueue(queue, entry);
    },

    reservePending(agentId, roomId, entry, threadRootId) {
      const queue = getScopedQueue(roomId, threadRootId);
      const snapshot = appendToQueue(queue, { ...entry, reserved: true });
      return {
        ...snapshot,
        slotIdx: snapshot.snapshotIdx - 1,
        watermarkIdx: agentWatermarks.get(wmKey(agentId, roomId, threadRootId)) ?? 0,
      };
    },

    finalizePending(roomId, slot, entry, threadRootId) {
      const queue = findScopedQueue(roomId, threadRootId);
      if (!queue || queue.generation !== slot.queueGeneration) {
        return;
      }
      const rel = slot.slotIdx - queue.baseIndex;
      if (rel < 0 || rel >= queue.entries.length) {
        return;
      }
      queue.entries[rel] = entry;
    },

    discardPending(roomId, slot, threadRootId) {
      const queue = findScopedQueue(roomId, threadRootId);
      if (!queue || queue.generation !== slot.queueGeneration) {
        return;
      }
      const rel = slot.slotIdx - queue.baseIndex;
      if (rel < 0 || rel >= queue.entries.length) {
        return;
      }
      queue.entries[rel] = {
        sender: "",
        body: "",
        messageId: undefined,
        discarded: true,
      };
    },

    getPendingHistory(agentId, roomId, limit, threadRootId) {
      const queue = findScopedQueue(roomId, threadRootId);
      if (!queue) {
        return [];
      }
      return computePendingHistory(
        queue,
        agentId,
        roomId,
        limit,
        undefined,
        undefined,
        threadRootId,
      );
    },

    recordTrigger(roomId, entry, threadRootId) {
      const queue = getScopedQueue(roomId, threadRootId);
      return appendToQueue(queue, entry);
    },

    prepareTrigger(agentId, roomId, limit, entry, threadRootId) {
      return prepareTriggerInternal(agentId, roomId, limit, entry, threadRootId);
    },

    prepareReservedTrigger(agentId, roomId, limit, slot, entry, threadRootId) {
      const queue = findScopedQueue(roomId, threadRootId);
      if (!queue || queue.generation !== slot.queueGeneration) {
        return prepareTriggerInternal(agentId, roomId, limit, entry, threadRootId);
      }
      const rel = slot.slotIdx - queue.baseIndex;
      if (rel < 0 || rel >= queue.entries.length) {
        return prepareTriggerInternal(agentId, roomId, limit, entry, threadRootId);
      }
      const retryKey = preparedTriggerKey(agentId, entry.messageId);
      if (retryKey) {
        const prepared = queue.preparedTriggers.get(retryKey);
        if (prepared) {
          queue.entries[rel] = {
            sender: "",
            body: "",
            messageId: undefined,
            discarded: true,
          };
          return rememberPreparedTrigger(queue, retryKey, prepared);
        }
      }
      queue.entries[rel] = entry;
      const prepared = {
        history: computePendingHistory(
          queue,
          agentId,
          roomId,
          limit,
          slot.slotIdx,
          slot.watermarkIdx,
          threadRootId,
        ),
        snapshotIdx: slot.slotIdx + 1,
        queueGeneration: queue.generation,
      };
      if (retryKey) {
        return rememberPreparedTrigger(queue, retryKey, prepared);
      }
      return prepared;
    },

    consumeHistory(agentId, roomId, snapshot, messageId, threadRootId) {
      const key = wmKey(agentId, roomId, threadRootId);
      const queue = findScopedQueue(roomId, threadRootId);
      if (!queue) {
        // The room or thread was evicted while this trigger was in flight. Keep eviction
        // authoritative so a late completion cannot recreate a stale watermark.
        agentWatermarks.delete(key);
        return;
      }
      if (queue.generation !== snapshot.queueGeneration) {
        // The room was evicted and recreated before this trigger completed. Reject the stale
        // snapshot so it cannot advance or erase state for the new queue generation.
        return;
      }
      const firstReservedRel = queue.entries.findIndex(
        (entry, index) => entry.reserved === true && queue.baseIndex + index < snapshot.snapshotIdx,
      );
      if (firstReservedRel >= 0) {
        markConsumedAfterReservedGap(queue, key, firstReservedRel, snapshot.snapshotIdx);
      }
      const consumableSnapshotIdx =
        firstReservedRel >= 0 ? queue.baseIndex + firstReservedRel : snapshot.snapshotIdx;
      // Monotone write: never regress an already-advanced watermark.
      // Guards against out-of-order completion when two triggers for the same
      // (agentId, roomId) are in-flight concurrently.
      rememberWatermark(key, consumableSnapshotIdx);
      const retryKey = preparedTriggerKey(agentId, messageId);
      if (retryKey) {
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
    reservePending: tracker.reservePending,
    finalizePending: tracker.finalizePending,
    discardPending: tracker.discardPending,
    prepareTrigger: tracker.prepareTrigger,
    prepareReservedTrigger: tracker.prepareReservedTrigger,
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
