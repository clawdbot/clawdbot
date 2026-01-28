import type { FollowupRun, QueueDropPolicy, QueueMode, QueueSettings } from "./types.js";
import { loadFollowupQueuesFromDisk, saveFollowupQueuesToDisk } from "./state.store.js";

export type FollowupQueueState = {
  items: FollowupRun[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  lastRun?: FollowupRun["run"];
  /** Timestamp when queue became empty (used for grace period before deletion) */
  emptyAt?: number;
};

export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP: QueueDropPolicy = "summarize";

export const FOLLOWUP_QUEUES = new Map<string, FollowupQueueState>();

// Track if we've restored from disk
let restoreAttempted = false;

export function persistFollowupQueues() {
  try {
    saveFollowupQueuesToDisk(FOLLOWUP_QUEUES);
  } catch {
    // ignore persistence failures
  }
}

function restoreFollowupQueuesOnce() {
  if (restoreAttempted) return;
  restoreAttempted = true;
  try {
    const restored = loadFollowupQueuesFromDisk();
    if (restored.size === 0) return;
    for (const [key, entry] of restored.entries()) {
      if (!key || !entry) continue;
      // Keep any newer in-memory entries
      if (!FOLLOWUP_QUEUES.has(key)) {
        FOLLOWUP_QUEUES.set(key, entry);
      }
    }
  } catch {
    // ignore restore failures
  }
}

export function getFollowupQueue(key: string, settings: QueueSettings): FollowupQueueState {
  // Restore queues from disk on first access
  restoreFollowupQueuesOnce();

  const existing = FOLLOWUP_QUEUES.get(key);
  if (existing) {
    existing.mode = settings.mode;
    existing.debounceMs =
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : existing.debounceMs;
    existing.cap =
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : existing.cap;
    existing.dropPolicy = settings.dropPolicy ?? existing.dropPolicy;
    return existing;
  }

  const created: FollowupQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs:
      typeof settings.debounceMs === "number"
        ? Math.max(0, settings.debounceMs)
        : DEFAULT_QUEUE_DEBOUNCE_MS,
    cap:
      typeof settings.cap === "number" && settings.cap > 0
        ? Math.floor(settings.cap)
        : DEFAULT_QUEUE_CAP,
    dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
    droppedCount: 0,
    summaryLines: [],
  };
  FOLLOWUP_QUEUES.set(key, created);
  persistFollowupQueues();
  return created;
}

export function clearFollowupQueue(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) return 0;
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) return 0;
  const cleared = queue.items.length + queue.droppedCount;
  queue.items.length = 0;
  queue.droppedCount = 0;
  queue.summaryLines = [];
  queue.lastRun = undefined;
  queue.lastEnqueuedAt = 0;
  FOLLOWUP_QUEUES.delete(cleaned);
  persistFollowupQueues();
  return cleared;
}
