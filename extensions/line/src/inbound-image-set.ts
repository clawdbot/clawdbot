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
};

type PendingLineImageSet<T> = {
  // Keyed by message id so a redelivered event replaces its part instead of
  // adding a duplicate image to the turn.
  parts: Map<string, PendingImageSetEntry<T>>;
  total?: number;
  /** Wakes the holder once the set is whole or its wait has expired. */
  release: () => void;
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
 *
 * The first part of a set becomes its holder and does not resolve until the set
 * completes or its wait expires; every later part resolves immediately. Keeping
 * the holder's dispatch open is what lets the combined turn run under a live
 * ingress adoption: a turn dispatched after every part had returned would be
 * refused by admission, so a set that never completes would never be delivered.
 */
export function createLineImageSetBuffer<T>(): (params: {
  key: string;
  messageId: string;
  index?: number;
  total?: number;
  part: T;
  flushDelayMs?: number;
}) => Promise<readonly T[] | null> {
  const pendingImageSets = new Map<string, PendingLineImageSet<T>>();

  /** Resolves the whole set for the holder, or null for a part that only joins it. */
  return async function bufferLineImageSetPart(params): Promise<readonly T[] | null> {
    const existing = pendingImageSets.get(params.key);
    const entry: PendingImageSetEntry<T> = {
      index: params.index,
      arrivedAt: Date.now(),
      part: params.part,
    };

    if (existing) {
      existing.parts.set(params.messageId, entry);
      // A later part may carry the total an earlier one omitted.
      existing.total ??= params.total;
      if (existing.total !== undefined && existing.parts.size >= existing.total) {
        existing.release();
      }
      return null;
    }

    let release = () => {};
    const whole = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: PendingLineImageSet<T> = {
      parts: new Map([[params.messageId, entry]]),
      total: params.total,
      release: () => {
        clearTimeout(pending.timer);
        release();
      },
      timer: setTimeout(release, params.flushDelayMs ?? IMAGE_SET_FLUSH_DELAY_MS),
    };
    pending.timer.unref?.();
    pendingImageSets.set(params.key, pending);

    if (pending.total !== undefined && pending.parts.size >= pending.total) {
      pending.release();
    }
    await whole;
    pendingImageSets.delete(params.key);
    return orderedParts(pending);
  };
}
