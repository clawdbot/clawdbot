import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "./worker-task-pool.js";

export type PoolFixtureInput = {
  label: string;
  exchanges?: number;
  counters?: SharedArrayBuffer;
  wait?: boolean;
  exitCode?: number;
  buffer?: ArrayBuffer;
};
export type PoolFixtureResult = {
  label: string;
  threadId: number;
  buffer?: ArrayBuffer;
  previousBufferBytes?: number;
};

let previousBuffer: ArrayBuffer | undefined;
serveWorkerTasks<PoolFixtureResult>(
  async (input, channel) => {
    assert.ok(isRecord(input));
    assert.ok(typeof input.label === "string");
    if (input.exitCode !== undefined) {
      assert.ok(typeof input.exitCode === "number");
      process.exit(input.exitCode);
    }
    if (input.counters) {
      assert.ok(input.counters instanceof SharedArrayBuffer);
      const counters = new Int32Array(input.counters);
      Atomics.add(counters, 0, 1);
      if (input.wait) {
        Atomics.wait(counters, 1, 0);
      }
    }
    if (input.exchanges && channel) {
      channel.consumeInput();
      for (let index = 0; index < Number(input.exchanges); index++) {
        const response = await channel.request({ label: input.label });
        response.consumed();
      }
    }
    const previousBufferBytes = previousBuffer?.byteLength;
    assert.ok(input.buffer === undefined || input.buffer instanceof ArrayBuffer);
    previousBuffer = input.buffer;
    return { label: input.label, threadId, buffer: input.buffer, previousBufferBytes };
  },
  { transferList: (value) => (value.buffer ? [value.buffer] : []) },
);
