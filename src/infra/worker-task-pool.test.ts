import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const workerUrl = new URL("./worker-task-pool.test-support.ts", import.meta.url);
const pools: WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>[] = [];
const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const trackWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);

function createPool(
  options: ConstructorParameters<typeof WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>>[0] = {
    workerUrl,
  },
) {
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    maxWorkers: 1,
    ...options,
  });
  pools.push(pool);
  return pool;
}

beforeEach(() => workerChannel.subscribe(trackWorker));
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  workerChannel.unsubscribe(trackWorker);
  for (const worker of workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
});

describe("worker task pool", () => {
  it("bounds parallel execution and reuses warm workers for queued requests", async () => {
    const pool = createPool({ workerUrl, maxWorkers: 2 });
    const counters = new SharedArrayBuffer(8);
    const view = new Int32Array(counters);
    const completion = Promise.all(
      ["first", "second", "third"].map((label) =>
        pool.run({ label, counters, wait: true }, { timeoutMs: 10_000 }),
      ),
    );
    void completion.catch(() => {});
    try {
      await expect.poll(() => Atomics.load(view, 0)).toBe(2);
      expect(workers).toHaveLength(2);
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      const results = await completion;
      expect(results.map((result) => result.label)).toEqual(["first", "second", "third"]);
      expect(new Set(results.map((result) => result.threadId)).size).toBe(2);
      expect(Atomics.load(view, 0)).toBe(3);
      expect((await pool.run({ label: "warm" }, { timeoutMs: 10_000 })).threadId).toBe(
        results[0]?.threadId,
      );
      expect(workers).toHaveLength(2);
    } finally {
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      await Promise.allSettled([completion]);
    }
  });

  it.each(["complete", "abort", "close"] as const)(
    "keeps tasks without a deadline pending until %s",
    async (ending) => {
      const pool = createPool();
      const counters = new SharedArrayBuffer(8);
      const view = new Int32Array(counters);
      const controller = new AbortController();
      const reason = new Error(`explicit ${ending}`);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const active = pool.run(
        { label: "active", counters, wait: true },
        ending === "abort" ? { signal: controller.signal } : {},
      );
      const queued = pool.run({ label: "queued" }, {});
      const settled = Promise.allSettled([active, queued]);
      try {
        // Omission must not install the pool's historical 60-second default timer.
        await vi.advanceTimersByTimeAsync(60_001);
        if (ending === "abort") {
          controller.abort(reason);
        } else if (ending === "close") {
          await pool.close(reason);
        } else {
          Atomics.store(view, 1, 1);
          Atomics.notify(view, 1);
        }
        const outcomes = await settled;
        expect(outcomes[0]).toEqual(
          ending === "complete"
            ? { status: "fulfilled", value: expect.objectContaining({ label: "active" }) }
            : { status: "rejected", reason },
        );
        expect(outcomes[1]).toEqual(
          ending === "close"
            ? { status: "rejected", reason }
            : { status: "fulfilled", value: expect.objectContaining({ label: "queued" }) },
        );
      } finally {
        Atomics.store(view, 1, 1);
        Atomics.notify(view, 1);
        await pool.close();
        await settled;
        vi.useRealTimers();
      }
    },
  );

  it("expires queued work and never launches cancelled asynchronous preparation", async () => {
    const pool = createPool();
    const counters = new SharedArrayBuffer(8);
    const view = new Int32Array(counters);
    const controller = new AbortController();
    const reason = new Error("cancel prepared task");
    let prepared!: (input: PoolFixtureInput) => void;
    const preparing = pool.run(
      () =>
        new Promise<PoolFixtureInput>((resolve) => {
          prepared = resolve;
        }),
      { timeoutMs: 10_000, signal: controller.signal },
    );
    const rejected = expect(preparing).rejects.toBe(reason);
    const queuedFactory = vi.fn(() => ({ label: "expired", counters }));
    await expect(pool.run(queuedFactory, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(queuedFactory).not.toHaveBeenCalled();
    controller.abort(reason);
    await rejected;
    prepared({ label: "abandoned", counters });
    await expect(
      pool.run({ label: "current", counters }, { timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ label: "current" });
    expect(Atomics.load(view, 0)).toBe(1);
    expect(workers).toHaveLength(1);
  });

  it("terminates only the cancelled worker before admitting its replacement", async () => {
    const pool = createPool();
    const counters = new SharedArrayBuffer(8);
    const controller = new AbortController();
    const reason = new Error("cancel execution");
    const active = pool.run(
      { label: "cancelled", counters, wait: true },
      { timeoutMs: 10_000, signal: controller.signal },
    );
    const rejected = expect(active).rejects.toBe(reason);
    await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
    const cancelledWorker = workers[0];
    const replacement = pool.run({ label: "replacement" }, { timeoutMs: 10_000 });
    controller.abort(reason);
    await rejected;
    expect(cancelledWorker?.threadId).toBe(-1);
    await expect(replacement).resolves.toMatchObject({ label: "replacement" });
    expect(workers).toHaveLength(2);
  });

  it.each([0, 1])(
    "rejects exit code %i before a response and recovers capacity",
    async (exitCode) => {
      const pool = createPool();
      await expect(
        pool.run({ label: "exit", exitCode }, { timeoutMs: 10_000 }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(pool.run({ label: "next" }, { timeoutMs: 10_000 })).resolves.toMatchObject({
        label: "next",
      });
      expect(workers).toHaveLength(2);
    },
  );

  it("closes a generation before a rejected result can dispatch its successor", async () => {
    const reason = new Error("generation superseded");
    const pool = createPool({
      workerUrl,
      restartOnError: false,
      validateResult: () => {
        throw reason;
      },
    });
    const first = pool.run({ label: "stale" }, { timeoutMs: 10_000 });
    const nextFactory = vi.fn(() => ({ label: "forbidden" }));
    const next = pool.run(nextFactory, { timeoutMs: 10_000 });
    await Promise.all([expect(first).rejects.toBe(reason), expect(next).rejects.toBe(reason)]);
    await expect(pool.run({ label: "closed" }, { timeoutMs: 10_000 })).rejects.toBe(reason);
    expect(nextFactory).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.threadId).toBe(-1);
  });

  it("does not recreate an idle generation worker after it crashes", async () => {
    const pool = createPool({ workerUrl, restartOnError: false, idleTimeoutMs: 0 });
    await pool.run({ label: "generation" }, { timeoutMs: 10_000 });
    const worker = workers[0];
    assert.ok(worker);
    await worker.terminate();
    await expect(pool.run({ label: "forbidden" }, { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(workers).toHaveLength(1);
  });

  it("retires idle compute workers and transfers uniquely owned buffers in both directions", async () => {
    const pool = createPool({ workerUrl, idleTimeoutMs: 20 });
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer)[0] = 42;
    const result = await pool.run(
      { label: "transfer", buffer },
      { timeoutMs: 10_000, transferList: (input) => [input.buffer!] },
    );
    expect(buffer.byteLength).toBe(0);
    expect(new Uint8Array(result.buffer!)[0]).toBe(42);
    expect((await pool.run({ label: "inspect" }, { timeoutMs: 10_000 })).previousBufferBytes).toBe(
      0,
    );
    await expect.poll(() => workers[0]?.threadId).toBe(-1);
    const next = await pool.run({ label: "new worker" }, { timeoutMs: 10_000 });
    expect(next.threadId).not.toBe(result.threadId);
  });

  it("arms idle retirement on the clock the pool was created under", async () => {
    const pool = createPool({ workerUrl, idleTimeoutMs: 20 });
    await pool.run({ label: "warm" }, { timeoutMs: 10_000 });
    // Process-wide pools finish work on worker messages, which can arrive inside an
    // unrelated test's fake-timer window; that clock must not receive the idle timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await pool.run({ label: "under a fake clock" }, {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    const worker = workers.at(-1);
    assert.ok(worker);
    await expect.poll(() => worker.threadId).toBe(-1);
  });

  it("lets a headless process exit while warm workers are idle", async () => {
    const moduleUrl = new URL("./worker-task-pool.ts", import.meta.url);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { WorkerTaskPool } from ${JSON.stringify(moduleUrl.href)};
       const pool = new WorkerTaskPool({ workerUrl: new URL(${JSON.stringify(workerUrl.href)}) });
       console.log((await pool.run({ label: "finished" }, { timeoutMs: 10000 })).label);`,
      ],
      { timeout: 15_000 },
    );
    expect(stdout.trim()).toBe("finished");
  }, 20_000);

  it("releases parent inputs while their worker copies are still executing", async () => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        fileURLToPath(new URL("./worker-task-pool.retention.test-support.ts", import.meta.url)),
      ],
      { timeout: 20_000 },
    );
  }, 25_000);
});
