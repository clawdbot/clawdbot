import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import * as logging from "../../logging/logger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SqliteSessionReclamationDiagnostics } from "./session-accessor.sqlite-contract.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { drainSessionStoreWriterQueuesForTest } from "./store-writer-state.js";

afterEach(() => vi.restoreAllMocks());

async function readFailedWriterLog(failure: unknown) {
  return await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_FILE_LOG: "1" } },
    async (state) => {
      const logPath = state.path("sqlite-write.log");
      logging.setLoggerOverride({ level: "warn", file: logPath });
      try {
        await expect(
          runExclusiveSqliteSessionWrite({ agentId: "main", env: state.env }, async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        await logging.flushLogger();
        const content = await fs.readFile(logPath, "utf8");
        const record: unknown = JSON.parse(content.trim());
        assert.ok(isRecord(record));
        const details = record["2"];
        assert.ok(isRecord(details));
        expect(record["1"]).toBe("SQLite session write failed");
        return { content, error: details.error };
      } finally {
        await logging.flushLogger();
        logging.resetLogger();
      }
    },
  );
}

test.each([false, true])(
  "failed writer file logs preserve redacted error details, worker=%s",
  async (inWorker) => {
    const secret = "synthetic-writer-credential-value";
    const message = "synthetic writer failure";
    const causeMessage = `synthetic storage failure; Authorization: Bearer ${secret}`;
    let failure: unknown;
    if (inWorker) {
      const worker = new Worker(
        `const { workerData } = require("node:worker_threads");
       throw Object.assign(new Error(workerData.message, { cause: new Error(workerData.causeMessage) }), { code: "SQLITE_BUSY" });`,
        { eval: true, execArgv: [], workerData: { message, causeMessage } },
      );
      try {
        failure = await new Promise<unknown>((resolve, reject) => {
          let received: unknown;
          let receivedError = false;
          worker.once("error", (error) => {
            received = error;
            receivedError = true;
          });
          worker.once("exit", () => {
            if (receivedError) {
              resolve(received);
            } else {
              reject(new Error("Synthetic worker exited without its expected error"));
            }
          });
        });
      } finally {
        await worker.terminate();
      }
    } else {
      failure = Object.assign(new Error(message, { cause: new Error(causeMessage) }), {
        code: "SQLITE_BUSY",
      });
    }
    const record = await readFailedWriterLog(failure);
    expect(record.error).toBeTypeOf("string");
    expect(record.error).toContain(message);
    expect(record.error).toContain("synthetic storage failure");
    expect(record.error).toContain("SQLITE_BUSY");
    expect(record.content).not.toContain(secret);
  },
);

test("failed writer error summaries are bounded without splitting a surrogate pair", async () => {
  const prefix = "x".repeat(2_047);
  const record = await readFailedWriterLog(new Error(`${prefix}🦞 trailing details`));
  expect(record.error).toBe(prefix);
});

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
      const diagnostics: SqliteSessionReclamationDiagnostics = {};
      const first = owners.run("first", () =>
        runExclusiveSqliteSessionWrite(
          scope,
          async () => {
            order.push("first:start");
            await release.promise;
            Object.assign(diagnostics, {
              kind: "history-eviction",
              workerThreadId: 7,
              payload: "must not enter diagnostics",
            });
            order.push("first:end");
            return "first";
          },
          diagnostics,
        ),
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
            pid: process.pid,
            threadId,
            isMainThread,
            reclamationKind: "history-eviction",
            workerThreadId: 7,
            elapsedMs: 2_000,
            queueWaitMs: 0,
            writerExecutionMs: 1_600,
            completionDelayMs: 400,
          }),
        );
        expect(records.find((entry) => entry.owner === "first")?.args[1]).not.toHaveProperty(
          "payload",
        );
        const record = records.find((entry) => entry.owner === "second");
        expect(record?.args[1]).toEqual(
          expect.objectContaining({
            pid: process.pid,
            threadId,
            isMainThread,
            elapsedMs: 1_900,
            queueWaitMs: 1_500,
            writerExecutionMs: 400,
            completionDelayMs: 0,
          }),
        );
        expect(record?.args[1]).not.toHaveProperty("reclamationKind");
        expect(record?.args[1]).not.toHaveProperty("workerThreadId");
        if (fail) {
          expect(record?.args[1]).toHaveProperty("error", failure.message);
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
