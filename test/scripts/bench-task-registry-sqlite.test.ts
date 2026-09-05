import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  testing,
  WORKER_RESULT_SENTINEL,
  type MemorySample,
  type WorkerResult,
} from "../../scripts/bench-task-registry-sqlite.ts";

function memorySample(cycle: number): MemorySample {
  return {
    cycle,
    heapUsedBytes: 100 + cycle,
    heapTotalBytes: 150 + cycle,
    rssBytes: 200 + cycle,
    externalBytes: 30 + cycle,
    arrayBuffersBytes: 10 + cycle,
    processPeakRssBytes: 250 + cycle,
  };
}

function workerResult(size: number, cycles = 3, warmup = 1): WorkerResult {
  return {
    size,
    timingsMs: {
      registration: Array.from({ length: cycles }, (_, index) => index + 1),
      terminal: Array.from({ length: cycles }, (_, index) => index + 2),
      teardown: Array.from({ length: cycles }, (_, index) => index + 3),
    },
    memory: {
      postGcBaseline: memorySample(-1),
      postGcSamples: Array.from({ length: cycles }, (_, index) => memorySample(index)),
      retainedSlopesBytesPerCycle: {
        heapUsedBytes: 1,
        heapTotalBytes: 1,
        rssBytes: 1,
        externalBytes: 1,
        arrayBuffersBytes: 1,
      },
      retainedDeltasBytes: {
        heapUsedBytes: cycles,
        heapTotalBytes: cycles,
        rssBytes: cycles,
        externalBytes: cycles,
        arrayBuffersBytes: cycles,
      },
      processPeakRssBytes: 300,
    },
    invariant: {
      ok: true,
      cyclesValidated: cycles + warmup,
      registration: {
        memory: {
          taskCount: size,
          deliveryStateCount: size,
          runningTasks: size,
          succeededTasks: 0,
          pendingDeliveryTasks: size,
          succeededTerminalOutcomes: 0,
        },
        sqlite: {
          taskCount: size,
          deliveryStateCount: size,
          runningTasks: size,
          succeededTasks: 0,
          pendingDeliveryTasks: size,
          succeededTerminalOutcomes: 0,
        },
      },
      terminal: {
        memory: {
          taskCount: size,
          deliveryStateCount: size,
          runningTasks: 0,
          succeededTasks: size,
          pendingDeliveryTasks: size,
          succeededTerminalOutcomes: size,
        },
        sqlite: {
          taskCount: size,
          deliveryStateCount: size,
          runningTasks: 0,
          succeededTasks: size,
          pendingDeliveryTasks: size,
          succeededTerminalOutcomes: size,
        },
      },
      teardown: {
        memory: {
          taskCount: 0,
          deliveryStateCount: 0,
          runningTasks: 0,
          succeededTasks: 0,
          pendingDeliveryTasks: 0,
          succeededTerminalOutcomes: 0,
        },
        sqlite: {
          taskCount: 0,
          deliveryStateCount: 0,
          runningTasks: 0,
          succeededTasks: 0,
          pendingDeliveryTasks: 0,
          succeededTerminalOutcomes: 0,
        },
      },
      serializedSharedConnection: true,
    },
  };
}

function workerStdout(result: WorkerResult): string {
  return `${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`;
}

describe("durable task registry churn benchmark", () => {
  it("parses bounded defaults and explicit options", () => {
    expect(testing.parseOptions([])).toMatchObject({
      sizes: [24, 64, 128],
      cycles: 20,
      warmup: 3,
    });
    expect(
      testing.parseOptions([
        "--sizes",
        "2,4",
        "--cycles",
        "5",
        "--warmup",
        "0",
        "--output",
        "bench.json",
        "--json",
      ]),
    ).toMatchObject({
      sizes: [2, 4],
      cycles: 5,
      warmup: 0,
      output: "bench.json",
      json: true,
    });
    expect(() => testing.parseOptions(["--sizes", "2,2"])).toThrow(
      "--sizes contains duplicate values",
    );
    expect(() => testing.parseOptions(["--cycles", "201"])).toThrow("--cycles must be at most 200");
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("launches an expose-gc worker and removes its state directory after a timeout", () => {
    const options = testing.parseOptions(["--sizes", "8", "--cycles", "2", "--warmup", "1"]);
    let stateDir: string | undefined;
    expect(() =>
      testing.runWorker(options, 8, {
        spawnWorker: (_command, args) => {
          const stateDirIndex = args.indexOf("--state-dir");
          stateDir = args[stateDirIndex + 1];
          if (!stateDir) {
            throw new Error("missing worker state directory");
          }
          expect(args).toEqual([
            "--expose-gc",
            "--import",
            "tsx",
            "scripts/bench-task-registry-sqlite-worker.ts",
            "--size",
            "8",
            "--cycles",
            "2",
            "--warmup",
            "1",
            "--state-dir",
            stateDir,
          ]);
          fs.writeFileSync(path.join(stateDir, "openclaw.sqlite"), "timeout fixture");
          return {
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
          };
        },
      }),
    ).toThrow("timed out after 300000ms");
    expect(stateDir).toBeDefined();
    expect(fs.existsSync(stateDir!)).toBe(false);
  });

  it("aggregates schema version 1 with raw memory samples and explicit interpretation", () => {
    const options = testing.parseOptions(["--sizes", "2,4", "--cycles", "3", "--warmup", "1"]);
    const report = testing.aggregateWorkerResults(options, [workerResult(2), workerResult(4)]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      benchmark: "durable-task-registry-churn",
      model: {
        unit: "subagent task-record registrations",
        isolation: "fresh --expose-gc worker process per size",
        workload:
          "all task records start running with pending delivery, transition to succeeded with a succeeded terminal outcome, then delete",
      },
      options: { sizes: [2, 4], cycles: 3, warmup: 1 },
      invariants: {
        ok: true,
        exactRegistrationTerminalAndTeardownState: true,
        zeroRowsAfterEveryTeardown: true,
      },
    });
    expect(report.interpretation.timings).toContain("advisory only");
    expect(report.interpretation.memory).toContain("neither claim nor rule out a memory leak");
    expect(report.sizes[0]?.memory.postGcBaseline.cycle).toBe(-1);
    expect(report.sizes[0]?.memory.postGcSamples).toHaveLength(3);
    expect(report.sizes[0]?.memory.retainedDeltasBytes.heapUsedBytes).toBe(3);
    expect(report.sizes[0]?.memory.retainedSlopesBytesPerCycle).not.toHaveProperty(
      "processPeakRssBytes",
    );
    expect(report.sizes[0]?.timingsMs.registration).toEqual({
      count: 3,
      min: 1,
      p50: 2,
      max: 3,
    });
    expect(JSON.stringify(report)).not.toContain(process.cwd());
  });

  it("rejects malformed, incomplete, failed, and timed-out worker results", () => {
    const expected = { size: 2, cycles: 3, warmup: 1 };
    const valid = workerResult(2);
    expect(
      testing.parseWorkerProcessResult(
        { status: 0, stdout: workerStdout(valid), stderr: "" },
        expected,
      ),
    ).toEqual(valid);
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 0, stdout: `${WORKER_RESULT_SENTINEL}{\n`, stderr: "" },
        expected,
      ),
    ).toThrow("returned invalid JSON");
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 0, stdout: workerStdout(workerResult(3)), stderr: "" },
        expected,
      ),
    ).toThrow("mismatched identity");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: workerStdout({
            ...valid,
            memory: { ...valid.memory, postGcSamples: valid.memory.postGcSamples.slice(1) },
          }),
          stderr: "",
        },
        expected,
      ),
    ).toThrow("invalid post-GC sample count");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: workerStdout({
            ...valid,
            memory: {
              ...valid.memory,
              retainedDeltasBytes: { ...valid.memory.retainedDeltasBytes, heapUsedBytes: 99 },
            },
          }),
          stderr: "",
        },
        expected,
      ),
    ).toThrow("retainedDeltasBytes.heapUsedBytes must be end minus baseline");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: workerStdout({
            ...valid,
            invariant: {
              ...valid.invariant,
              terminal: {
                ...valid.invariant.terminal,
                sqlite: { ...valid.invariant.terminal.sqlite, succeededTasks: 1 },
              },
            },
          }),
          stderr: "",
        },
        expected,
      ),
    ).toThrow("invariant.terminal.sqlite.succeededTasks was unexpected");
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 7, stdout: "", stderr: "worker exploded" },
        expected,
      ),
    ).toThrow("failed (7): worker exploded");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" }),
        },
        expected,
      ),
    ).toThrow("timed out after 300000ms");
  });

  it("runs a tiny durable create, terminal, delete smoke", () => {
    const smoke = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/bench-task-registry-sqlite.ts",
        "--sizes",
        "2",
        "--cycles",
        "1",
        "--warmup",
        "0",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        timeout: 120_000,
      },
    );
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(smoke.stderr).toContain("worker 1/1 complete size=2");
    const report = JSON.parse(smoke.stdout) as {
      invariants: { ok: boolean };
      sizes: Array<{ invariant: WorkerResult["invariant"] }>;
    };
    expect(report.invariants.ok).toBe(true);
    expect(report.sizes[0]?.invariant).toMatchObject({
      registration: {
        memory: { taskCount: 2, deliveryStateCount: 2, runningTasks: 2 },
        sqlite: { taskCount: 2, deliveryStateCount: 2, runningTasks: 2 },
      },
      terminal: {
        memory: {
          taskCount: 2,
          deliveryStateCount: 2,
          succeededTasks: 2,
          pendingDeliveryTasks: 2,
          succeededTerminalOutcomes: 2,
        },
        sqlite: {
          taskCount: 2,
          deliveryStateCount: 2,
          succeededTasks: 2,
          pendingDeliveryTasks: 2,
          succeededTerminalOutcomes: 2,
        },
      },
      teardown: {
        memory: { taskCount: 0, deliveryStateCount: 0 },
        sqlite: { taskCount: 0, deliveryStateCount: 0 },
      },
    });
  });

  it("supports help and ends failures with the marker", () => {
    const help = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-task-registry-sqlite.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("OpenClaw durable task registry churn benchmark");
    expect(help.stdout).toContain("--sizes <list>");
    expect(help.stderr).toBe("");

    const failure = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-task-registry-sqlite.ts", "--wat"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-task-registry-sqlite] FAILED (exit 1)",
    );
  });
});
