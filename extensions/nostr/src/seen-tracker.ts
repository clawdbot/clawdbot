/**
 * LRU-based seen event tracker with TTL support.
 * Prevents unbounded memory growth under high load or abuse.
 */

export interface SeenTrackerOptions {
  /** Maximum number of entries to track (default: 100,000) */
  maxEntries?: number;
  /** TTL in milliseconds (default: 1 hour) */
  ttlMs?: number;
  /** Prune interval in milliseconds (default: 10 minutes) */
  pruneIntervalMs?: number;
}

export interface SeenTracker {
  /** Check if an ID has been seen (also marks it as seen if not) */
  has: (id: string) => boolean;
  /** Mark an ID as seen */
  add: (id: string) => void;
  /** Check if ID exists without marking */
  peek: (id: string) => boolean;
  /** Delete an ID */
  delete: (id: string) => void;
  /** Clear all entries */
  clear: () => void;
  /** Get current size */
  size: () => number;
  /** Stop the pruning timer */
  stop: () => void;
  /** Pre-seed with IDs (useful for restart recovery) */
  seed: (ids: string[]) => void;
}

interface Entry {
  seenAt: number;
  // For LRU: track order via doubly-linked list
  prev: string | null;
  next: string | null;
}

/**
 * Create a new seen tracker with LRU eviction and TTL expiration.
 */
export function createSeenTracker(options?: SeenTrackerOptions): SeenTracker {
  const maxEntries = options?.maxEntries ?? 100_000;
  const ttlMs = options?.ttlMs ?? 60 * 60 * 1000; // 1 hour
  const pruneIntervalMs = options?.pruneIntervalMs ?? 10 * 60 * 1000; // 10 minutes

  // Main storage
  const entries = new Map<string, Entry>();

  // LRU tracking: head = most recent, tail = least recent
  let head: string | null = null;
  let tail: string | null = null;

  // Move an entry to the front (most recently used)
  function moveToFront(id: string): void {
    const entry = entries.get(id);
    if (!entry) {
      return;
    }

    // Already at front
    if (head === id) {
      return;
    }

    // Remove from current position
    if (entry.prev) {
      const prevEntry = entries.get(entry.prev);
      if (prevEntry) {
        prevEntry.next = entry.next;
      }
    }
    if (entry.next) {
      const nextEntry = entries.get(entry.next);
      if (nextEntry) {
        nextEntry.prev = entry.prev;
      }
    }

    // Update tail if this was the tail
    if (tail === id) {
      tail = entry.prev;
    }

    // Move to front
    entry.prev = null;
    entry.next = head;
    if (head) {
      const headEntry = entries.get(head);
      if (headEntry) {
        headEntry.prev = id;
      }
    }
    head = id;

    // If no tail, this is also the tail
    if (!tail) {
      tail = id;
    }
  }

  // Remove an entry from the linked list
  function removeFromList(id: string): void {
    const entry = entries.get(id);
    if (!entry) {
      return;
    }

    if (entry.prev) {
      const prevEntry = entries.get(entry.prev);
      if (prevEntry) {
        prevEntry.next = entry.next;
      }
    } else {
      head = entry.next;
    }

    if (entry.next) {
      const nextEntry = entries.get(entry.next);
      if (nextEntry) {
        nextEntry.prev = entry.prev;
      }
    } else {
      tail = entry.prev;
    }
  }

  // Evict the least recently used entry
  function evictLRU(): void {
    if (!tail) {
      return;
    }
    const idToEvict = tail;
    removeFromList(idToEvict);
    entries.delete(idToEvict);
  }

  function insertAtFront(id: string, seenAt: number): void {
    const newEntry: Entry = {
      seenAt,
      prev: null,
      next: head,
    };

    if (head) {
      const headEntry = entries.get(head);
      if (headEntry) {
        headEntry.prev = id;
      }
    }

    entries.set(id, newEntry);
    head = id;
    if (!tail) {
      tail = id;
    }
  }

  // Prune expired entries
  function pruneExpired(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [id, entry] of entries) {
      if (now - entry.seenAt > ttlMs) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      removeFromList(id);
      entries.delete(id);
    }
  }

  // Start pruning timer
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  if (pruneIntervalMs > 0) {
    pruneTimer = setInterval(pruneExpired, pruneIntervalMs);
    // Don't keep process alive just for pruning
    if (pruneTimer.unref) {
      pruneTimer.unref();
    }
  }

  function add(id: string): void {
    const now = Date.now();

    // If already exists, update and move to front
    const existing = entries.get(id);
    if (existing) {
      existing.seenAt = now;
      moveToFront(id);
      return;
    }

    // Evict if at capacity
    while (entries.size >= maxEntries) {
      evictLRU();
    }

    insertAtFront(id, now);
  }

  function has(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) {
      add(id);
      return false;
    }

    // Check if expired
    if (Date.now() - entry.seenAt > ttlMs) {
      removeFromList(id);
      entries.delete(id);
      add(id);
      return false;
    }

    // Mark as recently used
    entry.seenAt = Date.now();
    moveToFront(id);
    return true;
  }

  function peek(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) {
      return false;
    }

    // Check if expired
    if (Date.now() - entry.seenAt > ttlMs) {
      removeFromList(id);
      entries.delete(id);
      return false;
    }

    return true;
  }

  function deleteEntry(id: string): void {
    if (entries.has(id)) {
      removeFromList(id);
      entries.delete(id);
    }
  }

  function clear(): void {
    entries.clear();
    head = null;
    tail = null;
  }

  function size(): number {
    return entries.size;
  }

  function stop(): void {
    if (pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = undefined;
    }
  }

  function seed(ids: string[]): void {
    const now = Date.now();
    // Seed in reverse order so first IDs end up at front
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (!entries.has(id) && entries.size < maxEntries) {
        insertAtFront(id, now);
      }
    }
  }

  return {
    has,
    add,
    peek,
    delete: deleteEntry,
    clear,
    size,
    stop,
    seed,
  };
}
