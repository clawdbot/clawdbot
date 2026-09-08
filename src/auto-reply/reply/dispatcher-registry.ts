/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */
import { resolveGlobalSet } from "../../shared/global-singleton.js";

type TrackedDispatcher = {
  readonly pending: () => number;
};

const activeDispatchers = resolveGlobalSet<TrackedDispatcher>(
  Symbol.for("openclaw.activeReplyDispatchers"),
  "close-only",
);

/**
 * Register a reply dispatcher for global tracking.
 * Returns an unregister function to call when the dispatcher is no longer needed.
 */
export function registerDispatcher(pending: () => number): () => void {
  // Separate registrations must remain distinct even when they share a callback.
  const tracked: TrackedDispatcher = { pending };
  activeDispatchers.add(tracked);

  return () => {
    activeDispatchers.delete(tracked);
  };
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
