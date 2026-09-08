import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerTaskPool, type WorkerTaskResponse } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import { resolveCodeModeConfig, type CodeModeWorkerResult } from "./code-mode-runtime.js";
import type {
  CodeModeWorkerBoundary,
  CodeModeWorkerContinuation,
} from "./code-mode-worker-types.js";
import { runCodeModeWorker } from "./code-mode-worker.js";

const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
const sleep = "await new Promise(resolve => setTimeout(resolve, 0));";
const workerUrl = new URL("./code-mode.worker.ts", import.meta.url);
const pools: WorkerTaskPool<unknown, CodeModeWorkerResult>[] = [];
const resolveModule = createRequire(import.meta.url).resolve;
const modules = Promise.all([
  readFile(resolveModule("quickjs-wasi/quickjs.wasm")).then((bytes) => WebAssembly.compile(bytes)),
  readFile(resolveModule("quickjs-wasi/encoding.so")).then((bytes) => WebAssembly.compile(bytes)),
]).then(([wasmModule, encoding]) => ({
  wasmModule,
  wasmExtensions: [{ name: "encoding", wasm: encoding }],
}));

function input(source: string) {
  return { kind: "exec", source, config, catalog: [], namespaces: [] };
}
function resume(state: CodeModeWorkerBoundary, deadline: number): CodeModeWorkerContinuation {
  return {
    kind: "continue",
    timeoutMs: deadline - performance.now(),
    settledRequests: state.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
    pendingRequests: [],
  };
}
function pool(maxWorkers = 1) {
  const value = new WorkerTaskPool<unknown, CodeModeWorkerResult>({ workerUrl, maxWorkers });
  pools.push(value);
  return value;
}
async function payload(source: string) {
  return { ...input(source), ...(await modules) };
}
function boundary(value: unknown): CodeModeWorkerBoundary {
  expect(value).toMatchObject({ status: "boundary" });
  return value as CodeModeWorkerBoundary;
}
function response(
  command: CodeModeWorkerContinuation,
  onConsumed?: () => void,
): WorkerTaskResponse {
  return { input: command, timeoutMs: 10_000, onConsumed };
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((value) => value.close()));
});

describe("Code Mode live VM", () => {
  it.each([false, true])(
    "retains a 12 MiB guest allocation across inline timer: %s",
    async (timer) => {
      const deadline = performance.now() + config.timeoutMs;
      const result = await runCodeModeWorker(
        input(
          `const bytes = new Uint8Array(12 * 1024 * 1024); bytes[0] = 73; ${timer ? sleep : ""} return [bytes.length, bytes[0]];`,
        ),
        15_000,
        undefined,
        undefined,
        {
          onBoundary: async (value) => resume(value, deadline),
        },
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: { json: "[12582912,73]" },
      });
    },
  );

  it.each([0, 30])(
    "retains the snapshot limit at genuine parking after %i ms of host wait",
    async (hostDelay) => {
      const output = new CodeModeOutputState(config.maxOutputBytes);
      const onBoundary = vi.fn(async (value: CodeModeWorkerBoundary) => {
        output.append(value.output);
        expect(value.memoryUsedBytes).toBeGreaterThan(12 * 1024 * 1024);
        await delay(hostDelay);
        return { kind: "checkpoint" as const };
      });
      const result = await runCodeModeWorker(
        input(
          `const bytes = new Uint8Array(12 * 1024 * 1024); text("before parking"); ${sleep} return bytes.length;`,
        ),
        15_000,
        undefined,
        undefined,
        { onBoundary },
      );
      output.append(result.output);
      expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
      expect(onBoundary).toHaveBeenCalledTimes(1);
      expect(output.take().output).toEqual([{ type: "text", text: "before parking" }]);
    },
  );

  it("checkpoints a small VM and restores it with consumed input receipts", async () => {
    const parked = await runCodeModeWorker(
      input(`const value = 41; ${sleep} return value + 1;`),
      15_000,
      undefined,
      undefined,
      { onBoundary: async () => ({ kind: "checkpoint" }) },
    );
    expect(parked.status).toBe("waiting");
    if (parked.status !== "waiting") {
      throw new Error("expected checkpoint");
    }
    const consumed = vi.fn();
    const result = await runCodeModeWorker(
      {
        kind: "resume",
        snapshot: parked.snapshot,
        config,
        settledRequests: parked.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
        pendingRequests: [],
      },
      15_000,
      undefined,
      undefined,
      { onBoundary: async () => ({ kind: "checkpoint" }), onInputConsumed: consumed },
    );
    expect(result).toMatchObject({ status: "completed", value: { json: "42" } });
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it("keeps outputs and closures through many inline boundaries without leaking into the next cell", async () => {
    const deadline = performance.now() + config.timeoutMs;
    const output = new CodeModeOutputState(config.maxOutputBytes);
    const receipts = vi.fn();
    let boundaries = 0;
    const result = await runCodeModeWorker(
      input(
        `globalThis.privateCell = 73; const bytes = new Uint8Array(12 * 1024 * 1024); for (let i = 0; i < 8; i++) { text(i); ${sleep} bytes[i] = i; } return bytes[7];`,
      ),
      15_000,
      undefined,
      undefined,
      {
        onBoundary: async (value) => {
          boundaries++;
          output.append(value.output);
          return { ...resume(value, deadline), onConsumed: receipts };
        },
      },
    );
    output.append(result.output);
    expect(result).toMatchObject({ status: "completed", value: { json: "7" } });
    expect(boundaries).toBe(8);
    expect(receipts).toHaveBeenCalledTimes(8);
    expect(output.take().output).toEqual(
      Array.from({ length: 8 }, (_, i) => ({ type: "text", text: String(i) })),
    );
    const next = await runCodeModeWorker(input("return typeof privateCell;"), 15_000);
    expect(next).toMatchObject({ status: "completed", value: { json: '"undefined"' } });
  });

  it.each(["abort", "close"] as const)(
    "fences late host replies after %s and releases their ownership once",
    async (ending) => {
      const workers = pool();
      const entered = createDeferredCore();
      const late = createDeferredCore<WorkerTaskResponse>();
      const controller = new AbortController();
      const consumed = vi.fn();
      let calls = 0;
      const running = workers.run(await payload(`${sleep} text("forbidden"); ${sleep} return 1;`), {
        timeoutMs: 15_000,
        signal: controller.signal,
        onRequest: async () => {
          calls++;
          entered.resolve();
          return late.promise;
        },
      });
      const outcome = Promise.allSettled([running]);
      await entered.promise;
      if (ending === "abort") {
        controller.abort(new Error("owner closed"));
      } else {
        await workers.close();
      }
      expect((await outcome)[0].status).toBe("rejected");
      late.resolve(
        response(
          {
            kind: "continue",
            timeoutMs: 1000,
            settledRequests: [{ id: "bridge:sleep:1", ok: true, json: "null" }],
            pendingRequests: [],
          },
          consumed,
        ),
      );
      await expect.poll(() => consumed.mock.calls.length).toBe(1);
      expect(calls).toBe(1);
      if (ending === "abort") {
        expect(await workers.run(await payload("return 42;"), { timeoutMs: 15_000 })).toMatchObject(
          { status: "completed", value: { json: "42" } },
        );
      }
    },
  );

  it("releases response input only after consumption, and terminates a resumed CPU loop on abort", async () => {
    const workers = pool();
    const controller = new AbortController();
    const receipt = createDeferredCore();
    const consumed = vi.fn(() => receipt.resolve());
    const running = workers.run(await payload(`${sleep} while (true) {}`), {
      timeoutMs: 15_000,
      signal: controller.signal,
      onRequest: async (value) => {
        expect(consumed).not.toHaveBeenCalled();
        return response(resume(boundary(value), performance.now() + 1000), consumed);
      },
    });
    const outcome = Promise.allSettled([running]);
    await receipt.promise;
    controller.abort();
    expect((await outcome)[0].status).toBe("rejected");
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(await workers.run(await payload("return 9;"), { timeoutMs: 15_000 })).toMatchObject({
      status: "completed",
      value: { json: "9" },
    });
  });

  it("checkpoints a slow host waiter under contention so queued cells can run within the same capacity", async () => {
    const workers = pool();
    const entered = createDeferredCore();
    const yielded = vi.fn();
    const start = performance.now();
    const waiting = workers.run(await payload(`${sleep} return 1;`), {
      timeoutMs: 15_000,
      onRequest: async (_value, { yieldSignal }) => {
        entered.resolve();
        if (!yieldSignal.aborted) {
          await new Promise<void>((resolve) => {
            yieldSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        yielded();
        return response({ kind: "checkpoint" });
      },
    });
    await entered.promise;
    const quick = workers.run(await payload("return 2;"), { timeoutMs: 2000 });
    expect(await waiting).toMatchObject({ status: "waiting" });
    expect(await quick).toMatchObject({ status: "completed", value: { json: "2" } });
    expect(yielded).toHaveBeenCalledTimes(1);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("bounds concurrent live heaps to admitted worker capacity and keeps each cell isolated", async () => {
    const workers = pool(2);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let active = 0;
    let highWater = 0;
    let ownedBytes = 0;
    let peakBytes = 0;
    const calls = await Promise.all(
      [0, 1, 2, 3].map(async (id) => ({
        id,
        input: await payload(
          `const bytes = new Uint8Array(12 * 1024 * 1024); bytes[0] = ${id}; ${sleep} return bytes[0];`,
        ),
      })),
    );
    const results = calls.map(({ id, input: workerInput }) => {
      let liveBytes = 0;
      return workers
        .run(workerInput, {
          timeoutMs: 15_000,
          onRequest: async (value) => {
            const state = boundary(value);
            active++;
            highWater = Math.max(highWater, active);
            liveBytes = state.memoryUsedBytes;
            ownedBytes += liveBytes;
            peakBytes = Math.max(peakBytes, ownedBytes);
            if (active === 2) {
              entered.resolve();
            }
            await release.promise;
            return response({
              kind: "continue",
              timeoutMs: 1000,
              pendingRequests: [],
              settledRequests: state.pendingRequests.map(({ id: requestId }) => ({
                id: requestId,
                ok: true,
                json: JSON.stringify(id),
              })),
            });
          },
        })
        .finally(() => {
          if (liveBytes) {
            active--;
            ownedBytes -= liveBytes;
          }
        });
    });
    await entered.promise;
    expect(highWater).toBe(2);
    expect(peakBytes).toBeGreaterThan(24 * 1024 * 1024);
    expect(peakBytes).toBeLessThan(2 * config.memoryLimitBytes);
    release.resolve();
    expect(
      (await Promise.all(results)).map((result) =>
        result.status === "completed" ? result.value.json : result.status,
      ),
    ).toEqual(["0", "1", "2", "3"]);
    expect(highWater).toBe(2);
    expect(ownedBytes).toBe(0);
  });
  it.each(["task", "sequence"] as const)(
    "rejects stale worker %s messages before dispatching another host call",
    async (stale) => {
      const source = `import { parentPort } from 'node:worker_threads';
      parentPort.on('message', (message) => {
        if (message.responseId === undefined) {
          parentPort.postMessage({ status: 'request', taskId: message.taskId, id: 1, value: null });
        } else {
          parentPort.postMessage({ status: 'consumed', taskId: message.taskId, id: 1 });
          parentPort.postMessage({ status: 'request', taskId: message.taskId + ${stale === "task" ? 1 : 0}, id: 1, value: null });
        }
      });`;
      const workers = new WorkerTaskPool<unknown, CodeModeWorkerResult>({
        workerUrl: new URL("data:text/javascript," + encodeURIComponent(source)),
        maxWorkers: 1,
      });
      pools.push(workers);
      const consumed = vi.fn();
      const onRequest = vi.fn(async () => response({ kind: "checkpoint" }, consumed));
      await expect(workers.run({}, { timeoutMs: 2000, onRequest })).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(consumed).toHaveBeenCalledTimes(1);
    },
  );

  it("does not turn a snapshot-limit failure into timeout when host waiting exhausts the call budget", async () => {
    const workers = pool();
    const task = await payload(
      `const bytes = new Uint8Array(12 * 1024 * 1024); ${sleep} return bytes.length;`,
    );
    const result = await workers.run(
      { ...task, config: { ...config, timeoutMs: 200 } },
      {
        timeoutMs: 5000,
        onRequest: async () => {
          await delay(250);
          return response({ kind: "checkpoint" });
        },
      },
    );
    expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
  });
  it("pressures a newly waiting worker when an earlier pressured waiter has not yielded", async () => {
    const workers = pool(2);
    const firstEntered = createDeferredCore();
    const firstPressured = createDeferredCore();
    const releaseFirst = createDeferredCore();
    const prepareSecond = createDeferredCore<unknown>();
    const first = workers.run(await payload(`${sleep} return 1;`), {
      timeoutMs: 15_000,
      onRequest: async (_value, { yieldSignal }) => {
        yieldSignal.addEventListener("abort", () => firstPressured.resolve(), { once: true });
        firstEntered.resolve();
        await releaseFirst.promise;
        return response({ kind: "checkpoint" });
      },
    });
    await firstEntered.promise;
    const second = workers.run(() => prepareSecond.promise, {
      timeoutMs: 15_000,
      onRequest: async (_value, { signal, yieldSignal }) => {
        if (!yieldSignal.aborted && !signal.aborted) {
          await new Promise<void>((resolve) => {
            yieldSignal.addEventListener("abort", () => resolve(), { once: true });
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return response({ kind: "checkpoint" });
      },
    });
    const quick = workers.run(await payload("return 3;"), { timeoutMs: 2000 });
    const outcomes = Promise.allSettled([first, second, quick]);
    try {
      await firstPressured.promise;
      prepareSecond.resolve(await payload(`${sleep} return 2;`));
      await expect(quick).resolves.toMatchObject({ status: "completed", value: { json: "3" } });
      expect(await second).toMatchObject({ status: "waiting" });
    } finally {
      releaseFirst.resolve();
      await workers.close();
      await outcomes;
    }
  });
  it("releases an unconsumed invalid continuation only after worker termination", async () => {
    const workers = pool();
    const termination = vi.spyOn(Worker.prototype, "terminate");
    let releasedAtThreadIds: number[] | undefined;
    try {
      const result = await workers.run(await payload(`${sleep} return 1;`), {
        timeoutMs: 15_000,
        onRequest: async (value) =>
          response(
            {
              kind: "continue",
              timeoutMs: 0,
              pendingRequests: [],
              settledRequests: boundary(value).pendingRequests.map(({ id }) => ({
                id,
                ok: true,
                json: JSON.stringify("x".repeat(1024 * 1024)),
              })),
            },
            () => {
              releasedAtThreadIds = termination.mock.contexts.flatMap((worker) =>
                worker instanceof Worker ? [worker.threadId] : [],
              );
            },
          ),
      });
      expect(result).toMatchObject({ status: "failed", code: "timeout" });
      expect(releasedAtThreadIds).toContain(-1);
    } finally {
      await workers.close();
      termination.mockRestore();
    }
  });
});
