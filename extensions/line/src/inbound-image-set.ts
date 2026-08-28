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

type PendingLineImageSet<T> = {
  // Keyed by message id so a redelivered event replaces its part instead of
  // adding a duplicate image to the turn.
  parts: Map<string, { index?: number; arrivedAt: number; part: T }>;
  total?: number;
  flush: (parts: readonly T[]) => Promise<void>;
  onDetachedFlushError: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function orderedParts<T>(pending: PendingLineImageSet<T>): readonly T[] {
  return [...pending.parts.values()]
    .toSorted((left, right) =>
      left.index !== undefined && right.index !== undefined
        ? left.index - right.index
        : left.arrivedAt - right.arrivedAt,
    )
    .map((entry) => entry.part);
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
  flush: (parts: readonly T[]) => Promise<void>;
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
    pending.parts.set(params.messageId, {
      index: params.index,
      arrivedAt: Date.now(),
      part: params.part,
    });
    // A later part may carry the total an earlier one omitted, and the newest part
    // owns the flush so a timeout dispatches through the freshest reply token.
    pending.total ??= params.total;
    pending.flush = params.flush;
    pending.onDetachedFlushError = params.onDetachedFlushError;
    pendingImageSets.set(params.key, pending);

    if (pending.total !== undefined && pending.parts.size >= pending.total) {
      pendingImageSets.delete(params.key);
      await pending.flush(orderedParts(pending));
      return true;
    }

    pending.timer = setTimeout(() => {
      pendingImageSets.delete(params.key);
      // This runs after the webhook request that armed it was answered, so the
      // ingress drain has already settled that event and cannot retry a failure
      // here. Report it instead of leaving an unhandled rejection and a set with
      // no outcome at all.
      void pending.flush(orderedParts(pending)).catch(pending.onDetachedFlushError);
    }, params.flushDelayMs ?? IMAGE_SET_FLUSH_DELAY_MS);
    pending.timer.unref?.();
    return false;
  };
}
