import { threadId } from "node:worker_threads";
import { serveWorkerTasks } from "./worker-task-pool.js";

export type PoolFixtureInput = {
  label: string;
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
serveWorkerTasks<PoolFixtureInput, PoolFixtureResult>(
  (input) => {
    if (input.exitCode !== undefined) {
      process.exit(input.exitCode);
    }
    if (input.counters) {
      const counters = new Int32Array(input.counters);
      Atomics.add(counters, 0, 1);
      if (input.wait) {
        Atomics.wait(counters, 1, 0);
      }
    }
    const previousBufferBytes = previousBuffer?.byteLength;
    previousBuffer = input.buffer;
    return { label: input.label, threadId, buffer: input.buffer, previousBufferBytes };
  },
  { transferList: (value) => (value.buffer ? [value.buffer] : []) },
);
