const REPLAY_DISPATCH_CONCURRENCY = 8;
export const BUZZ_REPLAY_DISPATCH_MAX_PENDING = 1_024;
const REPLAY_HISTORY_MAX_PER_ROOM = 100;

type BuzzReplayDispatchAdmission = "accepted" | "closed" | "overflow";

export type BuzzReplayDispatchReservation = {
  enqueue: (task: () => Promise<void>) => BuzzReplayDispatchAdmission;
  release: () => void;
};

type BuzzReplayDispatchQueue = {
  enqueue: (task: () => Promise<void>) => BuzzReplayDispatchAdmission;
  reserveCapacity: (slots: number) => Promise<BuzzReplayDispatchReservation | undefined>;
  close: () => Promise<void>;
};

export function createBuzzReplayDispatchQueue(params: {
  onTaskError: (error: unknown) => void;
}): BuzzReplayDispatchQueue {
  const pending: Array<() => Promise<void>> = [];
  let pendingHead = 0;
  let active = 0;
  let closed = false;
  let resolveDrained: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  const settleDrained = () => {
    if (closed && active === 0) {
      resolveDrained?.();
      resolveDrained = undefined;
    }
  };

  let reserved = 0;
  const reservationWaiters: Array<{
    slots: number;
    resolve: (reservation: BuzzReplayDispatchReservation | undefined) => void;
  }> = [];
  const availableCapacity = () =>
    BUZZ_REPLAY_DISPATCH_MAX_PENDING - (pending.length - pendingHead) - reserved;

  const compactPending = () => {
    if (pendingHead > 256 && pendingHead * 2 >= pending.length) {
      pending.splice(0, pendingHead);
      pendingHead = 0;
    }
  };
  const drain = () => {
    if (closed) {
      return;
    }
    const startCount = Math.min(REPLAY_DISPATCH_CONCURRENCY - active, pending.length - pendingHead);
    for (let index = 0; index < startCount; index += 1) {
      const task = pending[pendingHead];
      pendingHead += 1;
      compactPending();
      if (!task) {
        continue;
      }
      active += 1;
      void Promise.resolve()
        .then(task)
        .catch(params.onTaskError)
        .finally(() => {
          active -= 1;
          settleDrained();
          drain();
        });
    }
    settleReservationWaiters();
  };

  const enqueueTask = (task: () => Promise<void>): BuzzReplayDispatchAdmission => {
    if (closed) {
      return "closed";
    }
    if (active < REPLAY_DISPATCH_CONCURRENCY) {
      pending.push(task);
      drain();
      return "accepted";
    }
    if (availableCapacity() <= 0) {
      return "overflow";
    }
    pending.push(task);
    return "accepted";
  };

  const createReservation = (slots: number): BuzzReplayDispatchReservation => {
    let remaining = slots;
    reserved += slots;
    return {
      enqueue(task) {
        if (closed) {
          return "closed";
        }
        if (remaining === 0) {
          return "overflow";
        }
        remaining -= 1;
        reserved -= 1;
        pending.push(task);
        drain();
        return "accepted";
      },
      release() {
        reserved -= remaining;
        remaining = 0;
        settleReservationWaiters();
      },
    };
  };

  const settleReservationWaiters = () => {
    while (reservationWaiters.length > 0) {
      const waiter = reservationWaiters[0];
      if (!waiter) {
        reservationWaiters.shift();
        continue;
      }
      if (closed) {
        reservationWaiters.shift();
        waiter.resolve(undefined);
        continue;
      }
      if (availableCapacity() < waiter.slots) {
        return;
      }
      reservationWaiters.shift();
      waiter.resolve(createReservation(waiter.slots));
    }
  };

  return {
    enqueue: enqueueTask,
    async reserveCapacity(slots) {
      if (closed) {
        return undefined;
      }
      if (reservationWaiters.length === 0 && availableCapacity() >= slots) {
        return createReservation(slots);
      }
      return await new Promise<BuzzReplayDispatchReservation | undefined>((resolve) => {
        reservationWaiters.push({ slots, resolve });
      });
    },
    async close() {
      closed = true;
      pending.length = 0;
      pendingHead = 0;
      settleReservationWaiters();
      settleDrained();
      await drained;
    },
  };
}

export function resolveBuzzRoomHistoryLimit(roomCount: number): number {
  const totalCapacity = BUZZ_REPLAY_DISPATCH_MAX_PENDING + REPLAY_DISPATCH_CONCURRENCY;
  return Math.min(
    REPLAY_HISTORY_MAX_PER_ROOM,
    Math.max(1, Math.floor(totalCapacity / Math.max(1, roomCount))),
  );
}
