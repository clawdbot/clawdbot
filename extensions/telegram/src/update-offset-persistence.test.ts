// Telegram tests cover monotonic update-offset persistence and retry.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramUpdateOffsetPersistence } from "./update-offset-persistence.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTelegramUpdateOffsetPersistence", () => {
  it("retries a failed write and coalesces the highest pending update", async () => {
    vi.useFakeTimers();
    const writes: number[] = [];
    let failFirstWrite = true;
    const onRetry = vi.fn();
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error("offset store unavailable");
        }
      },
      onInvalidUpdateId: vi.fn(),
      onRetry,
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    persistence.persistUpdateId(103);
    persistence.persistUpdateId(102);

    expect(writes).toEqual([101]);
    expect(persistence.getAcceptedUpdateId()).toBe(103);
    expect(persistence.getCommittedUpdateId()).toBe(100);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, updateId: 101 }));

    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    expect(writes).toEqual([101, 103]);
    expect(persistence.getCommittedUpdateId()).toBe(103);
    await persistence.stop();
  });

  it("never regresses when a lower update arrives during a higher write", async () => {
    const write = deferred();
    const writes: number[] = [];
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
        await write.promise;
      },
      onInvalidUpdateId: vi.fn(),
      onRetry: vi.fn(),
    });

    persistence.persistUpdateId(103);
    persistence.persistUpdateId(102);
    await flushMicrotasks();
    write.resolve();
    await flushMicrotasks();

    expect(writes).toEqual([103]);
    expect(persistence.getCommittedUpdateId()).toBe(103);
    await persistence.stop();
  });

  it("restarts the drain when a higher update arrives during teardown", async () => {
    const firstWrite = deferred();
    const writes: number[] = [];
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
        if (updateId === 101) {
          await firstWrite.promise;
        }
      },
      onInvalidUpdateId: vi.fn(),
      onRetry: vi.fn(),
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    firstWrite.resolve();
    queueMicrotask(() => persistence.persistUpdateId(102));
    await vi.waitFor(() => expect(writes).toEqual([101, 102]));

    expect(persistence.getAcceptedUpdateId()).toBe(102);
    expect(persistence.getCommittedUpdateId()).toBe(102);
    await persistence.stop();
  });

  it("fences an in-flight write before stop resolves", async () => {
    const write = deferred();
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async () => await write.promise,
      onInvalidUpdateId: vi.fn(),
      onRetry: vi.fn(),
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    let stopped = false;
    const stop = persistence.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    write.resolve();
    await stop;
    expect(stopped).toBe(true);
    expect(persistence.getCommittedUpdateId()).toBe(101);
  });

  it("cancels a scheduled retry when stopped", async () => {
    vi.useFakeTimers();
    const writeUpdateId = vi.fn(async () => {
      throw new Error("offset store unavailable");
    });
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId,
      onInvalidUpdateId: vi.fn(),
      onRetry: vi.fn(),
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    await persistence.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(writeUpdateId).toHaveBeenCalledTimes(1);
    expect(persistence.getCommittedUpdateId()).toBe(100);
  });

  it("does not rearm a failed write after the supplied signal aborts", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const writeUpdateId = vi.fn(async () => {
      throw new Error("offset store unavailable");
    });
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId,
      onInvalidUpdateId: vi.fn(),
      onRetry: vi.fn(),
      abortSignal: abortController.signal,
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    abortController.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(writeUpdateId).toHaveBeenCalledTimes(1);
    expect(persistence.getCommittedUpdateId()).toBe(100);
    await persistence.stop();
  });

  it("ignores a malformed update ID without blocking the next valid write", async () => {
    const writes: number[] = [];
    const onInvalidUpdateId = vi.fn();
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
      },
      onInvalidUpdateId,
      onRetry: vi.fn(),
    });

    persistence.persistUpdateId(Number.NaN);
    persistence.persistUpdateId(101);
    await flushMicrotasks();

    expect(onInvalidUpdateId).toHaveBeenCalledWith(Number.NaN);
    expect(writes).toEqual([101]);
    expect(persistence.getAcceptedUpdateId()).toBe(101);
    expect(persistence.getCommittedUpdateId()).toBe(101);
    await persistence.stop();
  });
});
