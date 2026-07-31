const REPLAY_DISPATCH_CONCURRENCY = 8;
export const BUZZ_REPLAY_DISPATCH_MAX_PENDING = 1_024;
const REPLAY_HISTORY_MAX_PER_ROOM = 100;

type BuzzReplayDispatchQueue = {
  enqueue: (task: () => Promise<void>) => "accepted" | "closed" | "overflow";
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
  };

  return {
    enqueue(task) {
      if (closed) {
        return "closed";
      }
      if (active < REPLAY_DISPATCH_CONCURRENCY) {
        pending.push(task);
        drain();
        return "accepted";
      }
      if (pending.length - pendingHead >= BUZZ_REPLAY_DISPATCH_MAX_PENDING) {
        return "overflow";
      }
      pending.push(task);
      return "accepted";
    },
    async close() {
      closed = true;
      pending.length = 0;
      pendingHead = 0;
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
