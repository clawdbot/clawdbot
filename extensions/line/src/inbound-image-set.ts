// Line plugin module groups the durable claims LINE splits one multi-image send into.

// LINE does not deliver several images picked in one action as one message. It
// sends one webhook event per image, ties them together with an imageSet id, and
// does not deliver them in order. Handled one at a time they become N concurrent
// turns for a single user action: the agent cannot answer about the set, and the
// turns contend so one of them ends with no reply at all.
//
// The parts are buffered here, at the ingress boundary that owns their durable
// claims, so the set reaches the handler as one delivery whose ownership spans
// every claim behind it.
//
// `index` and `total` are optional in LINE's own contract - older Android clients
// omit them - so completion can never be assumed and the timer, not the count, is
// what guarantees a set is always delivered.
const IMAGE_SET_FLUSH_DELAY_MS = 4_000;

type PendingImageSetPart<TEvent, TLifecycle> = {
  index?: number;
  arrivedAt: number;
  event: TEvent;
  lifecycle: TLifecycle;
};

type PendingImageSet<TEvent, TLifecycle> = {
  setId: string;
  // Keyed by message id so a redelivered event replaces its part instead of
  // adding a duplicate image to the turn.
  parts: Map<string, PendingImageSetPart<TEvent, TLifecycle>>;
  total?: number;
  /** Wakes the holder once the set is whole or its wait has expired. */
  release: () => void;
  /** Settles once the holder has taken the set and the lane is free again. */
  taken: Promise<void>;
  finishTaken: () => void;
  timer: ReturnType<typeof setTimeout>;
};

/** The whole set, ordered the way the sender picked it. */
type LineImageSetDelivery<TEvent, TLifecycle> = {
  events: readonly TEvent[];
  lifecycles: readonly TLifecycle[];
  /**
   * Frees the lane. Call it once the set has been delivered, not when it is
   * taken: the holder still has to fetch media and build its turn, and anything
   * released before that finishes would overtake the images it waited for.
   */
  finish: () => void;
};

/** Ordered by the index the sender picked, falling back to arrival. */
function orderedParts<TEvent, TLifecycle>(
  pending: PendingImageSet<TEvent, TLifecycle>,
): readonly PendingImageSetPart<TEvent, TLifecycle>[] {
  return [...pending.parts.values()].toSorted((left, right) =>
    left.index !== undefined && right.index !== undefined
      ? left.index - right.index
      : left.arrivedAt - right.arrivedAt,
  );
}

/**
 * Buffers the parts of a LINE image set until the set is whole.
 *
 * The first part becomes the set's holder: its call does not resolve until the
 * set completes or its wait expires, and it is the one that delivers. Keeping
 * that call open is what keeps the combined turn inside a live ingress
 * adoption - a turn dispatched after every part had returned is refused by
 * admission, so a set that never completes would never be delivered at all.
 */
export function createLineImageSetIngressBuffer<TEvent, TLifecycle>(): {
  admit: (input: {
    laneKey: string;
    setId: string;
    messageId: string;
    index?: number;
    total?: number;
    event: TEvent;
    lifecycle: TLifecycle;
    flushDelayMs?: number;
  }) => Promise<LineImageSetDelivery<TEvent, TLifecycle> | null>;
  awaitLane: (laneKey: string) => Promise<void>;
} {
  const pendingByLane = new Map<string, PendingImageSet<TEvent, TLifecycle>>();

  // Releasing the ingress lane is what lets the rest of a set arrive, but it also
  // lets anything the sender sent afterwards overtake the set. Everything else on
  // the lane waits here instead, so a later message still lands after the images.
  const awaitLane = async (laneKey: string): Promise<void> => {
    for (let pending = pendingByLane.get(laneKey); pending; pending = pendingByLane.get(laneKey)) {
      await pending.taken;
    }
  };

  const admit = async (input: {
    laneKey: string;
    setId: string;
    messageId: string;
    index?: number;
    total?: number;
    event: TEvent;
    lifecycle: TLifecycle;
    flushDelayMs?: number;
  }): Promise<LineImageSetDelivery<TEvent, TLifecycle> | null> => {
    const existing = pendingByLane.get(input.laneKey);
    if (existing && existing.setId !== input.setId) {
      // A different set is still forming on this lane; keep the sends in order.
      await awaitLane(input.laneKey);
    }
    const joined = pendingByLane.get(input.laneKey);
    const part: PendingImageSetPart<TEvent, TLifecycle> = {
      index: input.index,
      arrivedAt: Date.now(),
      event: input.event,
      lifecycle: input.lifecycle,
    };

    if (joined && joined.setId === input.setId) {
      joined.parts.set(input.messageId, part);
      // A later part may carry the total an earlier one omitted.
      joined.total ??= input.total;
      if (joined.total !== undefined && joined.parts.size >= joined.total) {
        joined.release();
      }
      return null;
    }

    let release = () => {};
    const whole = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finishTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      finishTaken = resolve;
    });
    const pending: PendingImageSet<TEvent, TLifecycle> = {
      setId: input.setId,
      parts: new Map([[input.messageId, part]]),
      total: input.total,
      release: () => {
        clearTimeout(pending.timer);
        release();
      },
      taken,
      finishTaken,
      timer: setTimeout(release, input.flushDelayMs ?? IMAGE_SET_FLUSH_DELAY_MS),
    };
    pending.timer.unref?.();
    pendingByLane.set(input.laneKey, pending);

    if (pending.total !== undefined && pending.parts.size >= pending.total) {
      pending.release();
    }
    await whole;
    const ordered = orderedParts(pending);
    return {
      events: ordered.map((entry) => entry.event),
      lifecycles: ordered.map((entry) => entry.lifecycle),
      finish: () => {
        if (pendingByLane.get(input.laneKey) === pending) {
          pendingByLane.delete(input.laneKey);
        }
        pending.finishTaken();
      },
    };
  };

  return { admit, awaitLane };
}
