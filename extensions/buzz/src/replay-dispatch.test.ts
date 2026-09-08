import { describe, expect, it } from "vitest";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
} from "./replay-dispatch.js";

const REPLAY_DISPATCH_CONCURRENCY = 8;

function createBlockedQueue() {
  const releases: Array<() => void> = [];
  const queue = createBuzzReplayDispatchQueue({ onTaskError: () => {} });
  const blockTask = () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    return async () => {
      await gate;
    };
  };
  return { queue, releases, blockTask };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("Buzz replay dispatch capacity reservations", () => {
  it("withholds a reservation while queued work occupies the pending limit", async () => {
    const { queue, blockTask } = createBlockedQueue();
    for (
      let index = 0;
      index < BUZZ_REPLAY_DISPATCH_MAX_PENDING + REPLAY_DISPATCH_CONCURRENCY;
      index += 1
    ) {
      expect(queue.enqueue(blockTask())).toBe("accepted");
    }

    let granted: unknown = "pending";
    void queue.reserveCapacity(10).then((reservation) => {
      granted = reservation;
    });
    await flush();

    expect(granted).toBe("pending");
    expect(queue.enqueue(blockTask())).toBe("overflow");
  });

  it("withholds reserved slots from later live events", async () => {
    const { queue, releases, blockTask } = createBlockedQueue();
    const pageSize = 100;
    for (
      let index = 0;
      index < BUZZ_REPLAY_DISPATCH_MAX_PENDING + REPLAY_DISPATCH_CONCURRENCY;
      index += 1
    ) {
      queue.enqueue(blockTask());
    }

    const reservationPromise = queue.reserveCapacity(pageSize);
    for (let index = 0; index < pageSize; index += 1) {
      releases[index]?.();
    }
    const reservation = await reservationPromise;
    expect(reservation).toBeDefined();

    for (let index = 0; index < pageSize; index += 1) {
      expect(queue.enqueue(blockTask())).toBe("overflow");
    }
    const admissions = new Set<string>();
    for (let index = 0; index < pageSize; index += 1) {
      admissions.add(reservation?.enqueue(blockTask()) ?? "missing");
    }

    expect([...admissions]).toEqual(["accepted"]);
    expect(reservation?.enqueue(blockTask())).toBe("overflow");
  });

  it("returns unused slots when a reservation is released", async () => {
    const { queue, releases, blockTask } = createBlockedQueue();
    for (
      let index = 0;
      index < BUZZ_REPLAY_DISPATCH_MAX_PENDING + REPLAY_DISPATCH_CONCURRENCY;
      index += 1
    ) {
      queue.enqueue(blockTask());
    }

    const firstPromise = queue.reserveCapacity(50);
    for (let index = 0; index < 50; index += 1) {
      releases[index]?.();
    }
    const first = await firstPromise;
    expect(first).toBeDefined();

    let second: unknown = "pending";
    void queue.reserveCapacity(50).then((reservation) => {
      second = reservation;
    });
    await flush();
    expect(second).toBe("pending");

    first?.release();
    await flush();
    expect(second).toBeDefined();
    expect(second).not.toBe("pending");
  });

  it("abandons waiting reservations once the queue closes", async () => {
    const { queue, blockTask } = createBlockedQueue();
    for (
      let index = 0;
      index < BUZZ_REPLAY_DISPATCH_MAX_PENDING + REPLAY_DISPATCH_CONCURRENCY;
      index += 1
    ) {
      queue.enqueue(blockTask());
    }
    const reservationPromise = queue.reserveCapacity(10);

    void queue.close();

    expect(await reservationPromise).toBeUndefined();
    expect(await queue.reserveCapacity(1)).toBeUndefined();
  });

  it("rejects work from a held reservation after the queue closes", async () => {
    const { queue, blockTask } = createBlockedQueue();
    const reservation = await queue.reserveCapacity(2);

    await queue.close();

    expect(reservation?.enqueue(blockTask())).toBe("closed");
    reservation?.release();
    expect(await queue.reserveCapacity(1)).toBeUndefined();
  });
});
