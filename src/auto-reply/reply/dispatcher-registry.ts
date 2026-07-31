/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */

type TrackedDispatcher = {
  readonly id: string;
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
};

const activeDispatchers = new Set<TrackedDispatcher>();
let nextId = 0;

/**
 * Register a reply dispatcher for global tracking.
 * Returns an unregister function to call when the dispatcher is no longer needed.
 */
export function registerDispatcher(dispatcher: {
  readonly pending: () => number;
  readonly waitForIdle: () => Promise<void>;
}): { id: string; unregister: () => void } {
  const id = `dispatcher-${++nextId}`;
  const tracked: TrackedDispatcher = {
    id,
    pending: dispatcher.pending,
    waitForIdle: dispatcher.waitForIdle,
  };
  activeDispatchers.add(tracked);

  const unregister = () => {
    activeDispatchers.delete(tracked);
  };

  return { id, unregister };
}

/**
 * Get the total number of pending replies across all dispatchers.
 */
export function getTotalPendingReplies(): number {
  let total = 0;
  for (const dispatcher of activeDispatchers) {
    total += dispatcher.pending();
  }
  return total;
}
