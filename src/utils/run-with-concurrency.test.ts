import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runTasksWithConcurrency } from "./run-with-concurrency.js";

describe("runTasksWithConcurrency", () => {
  it("keeps pending promise allocation bounded when the task list grows", async () => {
    async function countPendingPromises(taskCount: number): Promise<number> {
      const limit = 8;
      const started = createDeferred();
      const release = createDeferred();
      let startedCount = 0;
      let promiseCount = 0;
      const tasks = Array.from({ length: taskCount }, (_, index) => async () => {
        if (++startedCount === limit) {
          started.resolve();
        }
        await release.promise;
        return index;
      });
      const scope = new AsyncLocalStorage<boolean>();
      const hook = createHook({
        init(_id, type) {
          if (type === "PROMISE" && scope.getStore()) {
            promiseCount += 1;
          }
        },
      });
      let run: ReturnType<typeof runTasksWithConcurrency<number>> | undefined;
      hook.enable();
      try {
        run = scope.run(true, () => runTasksWithConcurrency({ tasks, limit }));
        await withTestTimeout(started.promise, 1_000, "initial workers did not start");
        return promiseCount;
      } finally {
        hook.disable();
        scope.disable();
        release.resolve();
        const result = await run;
        expect(result?.results).toEqual(Array.from({ length: taskCount }, (_, index) => index));
      }
    }

    const smallQueue = await countPendingPromises(32);
    const largeQueue = await countPendingPromises(4_096);
    // Pending async resources follow concurrency, not the number of unstarted tasks.
    expect(largeQueue).toBeLessThanOrEqual(smallQueue * 2);
  });

  it.each([false, true])(
    "isolates task contexts when the error hook throws (throwOnError=%s)",
    async (throwOnError) => {
      const scope = new AsyncLocalStorage<string>();
      async function runCaller(caller: string) {
        const taskError = new Error("task failed");
        const hookError = new Error("error hook failed");
        const completed = createDeferred();
        const starts: Array<string | undefined> = [];
        const failures: Array<{ error: unknown; index: number; context: string | undefined }> = [];
        let resumedContext: string | undefined;
        const run = scope.run(caller, () =>
          runTasksWithConcurrency({
            tasks: [
              async () => {
                starts.push(scope.getStore());
                scope.enterWith(`${caller}/task`);
                await Promise.resolve();
                resumedContext = scope.getStore();
                throw taskError;
              },
              async () => {
                starts.push(scope.getStore());
                completed.resolve();
                return 20;
              },
            ],
            limit: 1,
            throwOnError,
            onTaskError: (error, index) => {
              failures.push({ error, index, context: scope.getStore() });
              scope.enterWith(`${caller}/hook`);
              throw hookError;
            },
          }),
        );
        const observed = await scope.run(`${caller}/observer`, () =>
          run.then(
            (result) => ({ result, error: undefined, context: scope.getStore() }),
            (error: unknown) => ({ result: undefined, error, context: scope.getStore() }),
          ),
        );
        await withTestTimeout(completed.promise, 1_000, "queued task did not finish after error");
        expect(starts).toEqual([caller, caller]);
        expect(resumedContext).toBe(`${caller}/task`);
        expect(failures).toEqual([{ error: taskError, index: 0, context: `${caller}/task` }]);
        expect(observed.context).toBe(`${caller}/observer`);
        if (throwOnError) {
          expect(observed.error).toBe(hookError);
          expect(observed.result).toBeUndefined();
        } else {
          expect(observed.error).toBeUndefined();
          expect(observed.result).toEqual({
            results: [undefined, 20],
            firstError: taskError,
            hasError: true,
          });
        }
      }
      try {
        await Promise.all([runCaller("first"), runCaller("second")]);
      } finally {
        scope.disable();
      }
    },
  );

  it("retains the submitted factories when the caller changes its task array", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const tasks = [
      async () => {
        started.resolve();
        await release.promise;
        return 10;
      },
      async () => 20,
    ];
    const run = runTasksWithConcurrency({ tasks, limit: 1 });
    try {
      await withTestTimeout(started.promise, 1_000, "initial task did not start");
      tasks[1] = async () => 30;
      tasks.push(async () => 40);
      release.resolve();
      expect((await run).results).toEqual([10, 20]);
    } finally {
      release.resolve();
      await run;
    }
  });

  it("preserves task order with bounded worker count", async () => {
    let running = 0;
    let peak = 0;
    function createTask(index: number) {
      const started = createDeferred();
      const release = createDeferred();
      return {
        started: started.promise,
        release: release.resolve,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          started.resolve();
          await release.promise;
          running -= 1;
          return index + 1;
        },
      };
    }
    const first = createTask(0);
    const second = createTask(1);
    const third = createTask(2);
    const fourth = createTask(3);
    const tasks = [first, second, third, fourth].map((task) => task.run);

    const resultPromise = runTasksWithConcurrency({ tasks, limit: 2 });
    await withTestTimeout(first.started, 1_000, "task 0 did not start");
    await withTestTimeout(second.started, 1_000, "task 1 did not start");

    second.release();
    await withTestTimeout(third.started, 1_000, "task 2 did not start after releasing task 1");

    first.release();
    await withTestTimeout(fourth.started, 1_000, "task 3 did not start after releasing task 0");

    third.release();
    fourth.release();

    const result = await resultPromise;
    expect(result.hasError).toBe(false);
    expect(result.firstError).toBeUndefined();
    expect(result.results).toEqual([1, 2, 3, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("stops scheduling after first failure in stop mode", async () => {
    const err = new Error("boom");
    const seen: number[] = [];
    const tasks = [
      async () => {
        seen.push(0);
        return 10;
      },
      async () => {
        seen.push(1);
        throw err;
      },
      async () => {
        seen.push(2);
        return 30;
      },
    ];

    const result = await runTasksWithConcurrency({
      tasks,
      limit: 1,
      errorMode: "stop",
    });
    expect(result.hasError).toBe(true);
    expect(result.firstError).toBe(err);
    expect(result.results[0]).toBe(10);
    expect(result.results[2]).toBeUndefined();
    expect(seen).toEqual([0, 1]);
  });

  it("continues after failures and reports the first one", async () => {
    const firstErr = new Error("first");
    const secondErr = new Error("second");
    const onTaskError = vi.fn();
    const tasks = [
      async () => {
        throw firstErr;
      },
      async () => 20,
      async () => {
        throw secondErr;
      },
      async () => 40,
    ];

    const result = await runTasksWithConcurrency({
      tasks,
      limit: 1,
      errorMode: "continue",
      onTaskError,
    });
    expect(result.hasError).toBe(true);
    expect(result.firstError).toBe(firstErr);
    expect(result.results[1]).toBe(20);
    expect(result.results[3]).toBe(40);
    expect(onTaskError).toHaveBeenCalledTimes(2);
    expect(onTaskError).toHaveBeenNthCalledWith(1, firstErr, 0);
    expect(onTaskError).toHaveBeenNthCalledWith(2, secondErr, 2);
  });

  it("rejects early and stops scheduling new work in stop mode", async () => {
    const err = new Error("boom");
    const releaseInFlight = createDeferred();
    const inFlightSettled = createDeferred();
    const started: number[] = [];
    const run = runTasksWithConcurrency({
      tasks: [
        async () => {
          started.push(0);
          await releaseInFlight.promise;
          inFlightSettled.resolve();
          return 10;
        },
        async () => {
          started.push(1);
          throw err;
        },
        async () => {
          started.push(2);
          return 30;
        },
      ],
      limit: 2,
      errorMode: "stop",
      throwOnError: true,
    });

    await expect(run).rejects.toBe(err);
    releaseInFlight.resolve();
    await inFlightSettled.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(started).toEqual([0, 1]);
  });

  it("keeps scheduling after an early rejection in continue mode", async () => {
    const err = new Error("boom");
    const completed = createDeferred();
    const started: number[] = [];
    const run = runTasksWithConcurrency({
      tasks: [
        async () => {
          started.push(0);
          throw err;
        },
        async () => {
          started.push(1);
          completed.resolve();
          return 20;
        },
      ],
      limit: 1,
      errorMode: "continue",
      throwOnError: true,
    });

    await expect(run).rejects.toBe(err);
    await completed.promise;
    expect(started).toEqual([0, 1]);
  });
});
