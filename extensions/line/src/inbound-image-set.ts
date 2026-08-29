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
  // Keyed by message id so a redelivered event replaces its part instead of
  // adding a duplicate image to the turn.
  parts: Map<string, PendingImageSetPart<TEvent, TLifecycle>>;
  total?: number;
  /** Wakes the holder once the set is whole or its wait has expired. */
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** The whole set, ordered the way the sender picked it. */
type LineImageSetDelivery<TEvent, TLifecycle> = {
  events: readonly TEvent[];
  lifecycles: readonly TLifecycle[];
  /**
   * Leaves the lane queue. Call it once the set has been delivered, not when it
   * is taken: the holder still has to fetch media and build its turn, and
   * anything released before that finishes would overtake the images.
   */
  finish: () => void;
};

/**
 * Ordered by the index the sender picked, falling back to arrival.
 *
 * `index` is optional per part in LINE's contract, so a set can arrive partly
 * indexed. Choosing the key per pair would make the comparator intransitive and
 * the resulting order depend on insertion; ranking unindexed parts last keeps
 * one total order for every mix.
 */
function orderedParts<TEvent, TLifecycle>(
  pending: PendingImageSet<TEvent, TLifecycle>,
): readonly PendingImageSetPart<TEvent, TLifecycle>[] {
  return [...pending.parts.values()].toSorted(
    (left, right) =>
      (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER) ||
      left.arrivedAt - right.arrivedAt,
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
  /** Whether anything on this lane is still queued behind deferred work. */
  isBusy: (laneKey: string) => boolean;
  /**
   * Takes a place in the lane's queue, resolving when it is this event's turn.
   * Deferring frees the drain's lane, so this queue is the only thing keeping
   * events released behind a set from racing each other into delivery. Every
   * deferred event takes a place here, image sets included, so one lane has one
   * order rather than a set path and a message path that cannot see each other.
   */
  enterLane: (laneKey: string) => Promise<() => void>;
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
} {
  // Sets still open to their remaining parts, keyed the way LINE ties them
  // together. Registered before the starter waits its turn, so parts that arrive
  // while it is still queued join it instead of starting a second set.
  const pendingBySet = new Map<string, PendingImageSet<TEvent, TLifecycle>>();
  // Tail of each lane's queue: everything that deferred waits behind it in turn.
  const laneChain = new Map<string, Promise<void>>();

  const enterLane = async (laneKey: string): Promise<() => void> => {
    const prior = laneChain.get(laneKey) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mine = prior.then(async () => await held);
    laneChain.set(laneKey, mine);
    await prior;
    return () => {
      release();
      if (laneChain.get(laneKey) === mine) {
        laneChain.delete(laneKey);
      }
    };
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
    const part: PendingImageSetPart<TEvent, TLifecycle> = {
      index: input.index,
      arrivedAt: Date.now(),
      event: input.event,
      lifecycle: input.lifecycle,
    };

    const forming = pendingBySet.get(input.setId);
    if (forming) {
      forming.parts.set(input.messageId, part);
      // A later part may carry the total an earlier one omitted.
      forming.total ??= input.total;
      if (forming.total !== undefined && forming.parts.size >= forming.total) {
        forming.release();
      }
      return null;
    }

    let release = () => {};
    const whole = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: PendingImageSet<TEvent, TLifecycle> = {
      parts: new Map([[input.messageId, part]]),
      total: input.total,
      release: () => {
        clearTimeout(pending.timer);
        release();
      },
    };
    pendingBySet.set(input.setId, pending);
    const releaseLane = await enterLane(input.laneKey);
    // The wait starts here, not on arrival: time spent queued behind earlier work
    // on this lane is not time LINE spent delivering the rest of the set.
    pending.timer = setTimeout(pending.release, input.flushDelayMs ?? IMAGE_SET_FLUSH_DELAY_MS);
    pending.timer.unref?.();
    if (pending.total !== undefined && pending.parts.size >= pending.total) {
      pending.release();
    }
    await whole;
    // These parts are the turn. A part arriving after this starts its own set and
    // queues behind this delivery rather than joining a snapshot it missed.
    pendingBySet.delete(input.setId);
    const ordered = orderedParts(pending);
    return {
      events: ordered.map((entry) => entry.event),
      lifecycles: ordered.map((entry) => entry.lifecycle),
      finish: releaseLane,
    };
  };

  return { admit, enterLane, isBusy: (laneKey) => laneChain.has(laneKey) };
}
