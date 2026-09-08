import assert from "node:assert/strict";
import { setImmediate, setTimeout } from "node:timers/promises";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
  workerUrl: new URL("./worker-task-pool.test-support.ts", import.meta.url),
  maxWorkers: 1,
});

try {
  for (const factory of [false, true]) {
    const counters = new SharedArrayBuffer(8);
    const view = new Int32Array(counters);
    let reference!: WeakRef<ArrayBuffer>;
    const completion = (() => {
      const buffer = new ArrayBuffer(1024 * 1024);
      new Uint8Array(buffer)[0] = 37;
      reference = new WeakRef(buffer);
      const input = { label: "retention", counters, wait: true, buffer };
      return pool.run(factory ? () => input : input, { timeoutMs: 10_000 });
    })();
    void completion.catch(() => {});
    try {
      const deadline = Date.now() + 10_000;
      while (Atomics.load(view, 0) !== 1) {
        assert.ok(Date.now() < deadline, "worker must receive input");
        await setTimeout(5);
      }
      for (let index = 0; index < 4; index++) {
        await setImmediate();
        global.gc!();
      }
      assert.equal(
        reference.deref() === undefined,
        true,
        `parent retained ${factory ? "factory" : "direct"} input`,
      );
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      const result = await completion;
      assert.equal(result.label, "retention");
      assert.equal(new Uint8Array(result.buffer!)[0], 37);
    } finally {
      Atomics.store(view, 1, 1);
      Atomics.notify(view, 1);
      await Promise.allSettled([completion]);
    }
  }
} finally {
  await pool.close();
}
