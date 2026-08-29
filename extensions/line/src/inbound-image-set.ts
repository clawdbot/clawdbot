// Line plugin module groups the events LINE splits one multi-image send into.

// LINE does not deliver several images picked in one action as one message. It
// sends one webhook event per image, ties them together with an imageSet id, and
// does not deliver them in order. Handled one at a time they become N concurrent
// turns for a single user action: the agent cannot answer about the set, and the
// turns contend so one of them ends with no reply at all. Parts wait here until
// the set is whole, then leave as a single turn.
//
// `index` and `total` are optional in LINE's own contract - older Android clients
// omit them - so completion can never be assumed and the timer, not the count, is
// what guarantees a set is always delivered.
const IMAGE_SET_FLUSH_DELAY_MS = 4_000;

type PendingImageSetEntry<T> = {
  index?: number;
  arrivedAt: number;
  part: T;
  // Set once this part's webhook request has returned with its ingress claim
  // deferred, so the combined turn still owes that claim a terminal outcome.
  deferred: boolean;
};

type PendingLineImageSet<T> = {
  // Keyed by message id so a redelivered event replaces its part instead of
  // adding a duplicate image to the turn.
  parts: Map<string, PendingImageSetEntry<T>>;
  total?: number;
  flush: (parts: readonly T[], deferredParts: readonly T[]) => Promise<void>;
  onDetachedFlushError: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function orderedEntries<T>(pending: PendingLineImageSet<T>): readonly PendingImageSetEntry<T>[] {
  return [...pending.parts.values()].toSorted((left, right) =>
    left.index !== undefined && right.index !== undefined
      ? left.index - right.index
      : left.arrivedAt - right.arrivedAt,
  );
}

// Parts whose request already returned are handed over separately: the combined
// turn owns settling their still-held ingress claims.
function flushPendingImageSet<T>(pending: PendingLineImageSet<T>): Promise<void> {
  const entries = orderedEntries(pending);
  return pending.flush(
    entries.map((entry) => entry.part),
    entries.filter((entry) => entry.deferred).map((entry) => entry.part),
  );
}

/**
 * Creates the buffer that holds LINE image-set parts until the set is whole. The
 * pending map lives in the returned closure so the part type stays concrete.
 */
export function createLineImageSetBuffer<T>(): (params: {
  key: string;
  messageId: string;
  index?: number;
  total?: number;
  part: T;
  /**
   * Delivers the whole set. `deferredParts` are the parts whose webhook request
   * already returned, so the flush owes each of their ingress claims a terminal
   * outcome; rejecting hands them all back to the durable queue.
   */
  flush: (parts: readonly T[], deferredParts: readonly T[]) => Promise<void>;
  /** Reports a delayed flush that failed after its webhook request was answered. */
  onDetachedFlushError: (error: unknown) => void;
  flushDelayMs?: number;
}) => Promise<boolean> {
  const pendingImageSets = new Map<string, PendingLineImageSet<T>>();

  /** Resolves true when this call delivered the whole set, false while it waits. */
  return async function bufferLineImageSetPart(params): Promise<boolean> {
    const pending: PendingLineImageSet<T> = pendingImageSets.get(params.key) ?? {
      parts: new Map(),
      total: params.total,
      flush: params.flush,
      onDetachedFlushError: params.onDetachedFlushError,
      timer: setTimeout(() => {}, 0),
    };
    clearTimeout(pending.timer);
    const entry: PendingImageSetEntry<T> = {
      index: params.index,
      arrivedAt: Date.now(),
      part: params.part,
      deferred: false,
    };
    pending.parts.set(params.messageId, entry);
    // A later part may carry the total an earlier one omitted, and the newest part
    // owns the flush so a timeout dispatches through the freshest reply token.
    pending.total ??= params.total;
    pending.flush = params.flush;
    pending.onDetachedFlushError = params.onDetachedFlushError;
    pendingImageSets.set(params.key, pending);

    if (pending.total !== undefined && pending.parts.size >= pending.total) {
      pendingImageSets.delete(params.key);
      await flushPendingImageSet(pending);
      return true;
    }

    // This part's request is about to return while the set is still incomplete.
    // Its ingress claim stays deferred so a combined turn that later fails is
    // retried from the durable queue instead of losing the user's send.
    entry.deferred = true;
    pending.timer = setTimeout(() => {
      pendingImageSets.delete(params.key);
      // Every part here is deferred, so the flush settles their claims. A
      // rejection means it could not, and the drain's pre-adoption watchdog
      // releases them; report it rather than leave an unhandled rejection.
      void flushPendingImageSet(pending).catch(pending.onDetachedFlushError);
    }, params.flushDelayMs ?? IMAGE_SET_FLUSH_DELAY_MS);
    pending.timer.unref?.();
    return false;
  };
}
