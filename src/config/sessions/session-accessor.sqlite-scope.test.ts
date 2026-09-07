import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { afterEach, expect, test, vi } from "vitest";
import * as logging from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { drainSessionStoreWriterQueuesForTest } from "./store-writer-state.js";

afterEach(() => vi.restoreAllMocks());

test.each([false, true])(
  "slow writer diagnostics separate waiting and execution without changing failure=%s",
  async (fail) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      let clock = 0;
      const wallStart = Date.now();
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      vi.spyOn(Date, "now").mockImplementation(() => wallStart + clock);
      const owners = new AsyncLocalStorage<string>();
      const records: Array<{ owner: string | undefined; args: unknown[] }> = [];
      const getChildLogger = logging.getChildLogger;
      vi.spyOn(logging, "getChildLogger").mockImplementation((...args) => {
        const logger = getChildLogger(...args);
        vi.spyOn(logger, "warn").mockImplementation((...values) => {
          records.push({ owner: owners.getStore(), args: values });
          return undefined;
        });
        return logger;
      });
      const scope = { agentId: "main", env: state.env };
      const release = createDeferredCore();
      const order: string[] = [];
      const first = owners.run("first", () =>
        runExclusiveSqliteSessionWrite(scope, async () => {
          order.push("first:start");
          await release.promise;
          order.push("first:end");
          return "first";
        }),
      );
      expect(order).toEqual(["first:start"]);
      clock = 100;
      const failure = new Error("synthetic writer failure");
      const second = owners.run("second", () =>
        runExclusiveSqliteSessionWrite(scope, async () => {
          order.push("second:start");
          clock += 400;
          if (fail) {
            throw failure;
          }
          return "second";
        }),
      );
      const settled = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const queuedSuccessor = owners.run("queued-successor", () =>
        runExclusiveSqliteSessionWrite(scope, async () => {
          order.push("queued-successor");
          return "queued-successor";
        }),
      );
      try {
        expect(order).toEqual(["first:start"]);
        clock = 1_600;
        release.resolve();
        expect(await first).toBe("first");
        expect(await settled).toEqual(fail ? { error: failure } : { value: "second" });
        expect(await queuedSuccessor).toBe("queued-successor");
        expect(order).toEqual(["first:start", "first:end", "second:start", "queued-successor"]);
        expect(records.find((entry) => entry.owner === "first")?.args[1]).toEqual(
          expect.objectContaining({
            elapsedMs: 2_000,
            queueWaitMs: 0,
            writerExecutionMs: 1_600,
            completionDelayMs: 400,
          }),
        );
        const record = records.find((entry) => entry.owner === "second");
        expect(record?.args[1]).toEqual(
          expect.objectContaining({
            elapsedMs: 1_900,
            queueWaitMs: 1_500,
            writerExecutionMs: 400,
            completionDelayMs: 0,
          }),
        );
        if (fail) {
          expect(record?.args[1]).toHaveProperty("error", failure);
        }
        await expect(runExclusiveSqliteSessionWrite(scope, async () => "successor")).resolves.toBe(
          "successor",
        );
      } finally {
        release.resolve();
        await Promise.allSettled([first, second, queuedSuccessor]);
        vi.restoreAllMocks();
      }
    });
  },
);

test("a queued writer rejected by cleanup never runs after release", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", env: state.env };
    const release = createDeferredCore();
    const first = runExclusiveSqliteSessionWrite(scope, async () => await release.promise);
    const run = vi.fn(async () => "never");
    const second = runExclusiveSqliteSessionWrite(scope, run);
    const rejected = expect(second).rejects.toThrow("SQLite session store queue cleared for test");
    const drained = drainSessionStoreWriterQueuesForTest();
    try {
      await rejected;
      expect(run).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second, drained]);
    }
    expect(run).not.toHaveBeenCalled();
  });
});
