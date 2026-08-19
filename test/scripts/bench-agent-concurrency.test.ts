import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { testing as workerTesting } from "../../scripts/bench-agent-concurrency-worker.ts";
import {
  testing,
  WORKER_RESULT_SENTINEL,
  type WorkerResult,
  type WorkerScenario,
} from "../../scripts/bench-agent-concurrency.ts";
import {
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../src/process/gateway-work-admission.js";
import { createDeferred } from "../helpers/promise.js";

function workerResult(scenario: WorkerScenario, size: number, timingsMs = [1, 2, 3]): WorkerResult {
  const invariant: Record<string, number | boolean> =
    scenario === "spawnPipelineInMemory" || scenario === "spawnPipelineDurable"
      ? {
          ok: true,
          registeredRuns: size,
          reservationsReleased: size,
          blockedWaits: size,
          settledRuns: size,
          settledTasks: size,
          outstandingWaits: 0,
          durableSubagentRows: scenario === "spawnPipelineDurable" ? size : 0,
          durableTaskRows: scenario === "spawnPipelineDurable" ? size : 0,
          durableStateFile: scenario === "spawnPipelineDurable",
          postTeardownRegistryRows: 0,
          postTeardownTaskRows: 0,
          postTeardownDurableSubagentRows: 0,
          postTeardownDurableTaskRows: 0,
          postTeardownActiveRootWork: 0,
        }
      : scenario === "admission"
        ? { ok: true, admissionCap: size, overflowRejected: true, released: true }
        : scenario === "recoverySweep"
          ? {
              ok: true,
              seededRows: size * 3,
              removedRows: size * 2,
              retainedCurrent: size,
              sessionEffects: 0,
              recoveryProjections: size,
              lostContextCompletions: 0,
            }
          : {
              ok: true,
              inputRowsPerOrdering: size * 3,
              newestFirstSelectedRows: size,
              oldestFirstSelectedRows: size,
              newestFirstSelectedNewest: true,
              oldestFirstSelectedNewest: true,
            };
  return {
    scenario,
    size,
    timingsMs,
    memory: {
      rssStartBytes: 100,
      rssEndBytes: 120,
      processMaxRssBytes: 150,
    },
    invariant,
  };
}

function workerStdout(result: WorkerResult): string {
  return `${WORKER_RESULT_SENTINEL}${JSON.stringify(result)}\n`;
}

describe("agent concurrency benchmark", () => {
  it("parses bounded options and rejects ambiguous arguments", () => {
    expect(
      testing.parseOptions([
        "--runs",
        "2",
        "--warmup",
        "0",
        "--fanout",
        "1,4",
        "--sweep-rows",
        "8,16",
        "--output",
        "bench.json",
        "--json",
      ]),
    ).toMatchObject({
      runs: 2,
      warmup: 0,
      fanout: [1, 4],
      sweepRows: [8, 16],
      output: "bench.json",
      json: true,
    });
    expect(() => testing.parseOptions(["--runs", "101"])).toThrow("--runs must be at most 100");
    expect(() => testing.parseOptions(["--fanout", "1,1"])).toThrow(
      "--fanout contains duplicate values",
    );
    expect(() => testing.parseOptions(["--runs", "1", "--runs", "2"])).toThrow(
      "--runs was provided more than once",
    );
    expect(() => testing.parseOptions(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("emits tail percentiles only when the sample supports them", () => {
    expect(testing.summarizeTimings([100, 1, 4, 2, 3])).toEqual({
      count: 5,
      min: 1,
      p50: 3,
      max: 100,
    });
    const summary = testing.summarizeTimings(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(summary).toMatchObject({ count: 20, p50: 10, p95: 19, p99: 20, max: 20 });
  });

  it("drains detached gateway active work before the next spawn sample", async () => {
    resetGatewayWorkAdmission();
    const deferred = createDeferred();
    const rootWork = runWithGatewayIndependentRootWorkAdmission(() => deferred.promise);
    try {
      const drain = workerTesting.drainSpawnSampleActiveWork();
      await expect(
        Promise.race([
          drain.then(() => "drained"),
          new Promise<string>((resolve) => {
            setImmediate(() => resolve("pending"));
          }),
        ]),
      ).resolves.toBe("pending");

      deferred.resolve();
      await expect(drain).resolves.toBeUndefined();
    } finally {
      deferred.resolve();
      await rootWork;
      resetGatewayWorkAdmission();
    }
  });

  it("rejects a spawn sample when detached gateway active work does not drain", async () => {
    await expect(
      workerTesting.drainSpawnSampleActiveWork(async (timeoutMs) => {
        expect(timeoutMs).toBe(30_000);
        return { drained: false, snapshot: { counts: { totalActive: 2 } } };
      }),
    ).rejects.toThrow("spawn sample left 2 active gateway work items");
  });

  it("aggregates synthetic worker results into schema version 2", () => {
    const options = testing.parseOptions([
      "--runs",
      "3",
      "--warmup",
      "1",
      "--fanout",
      "2",
      "--sweep-rows",
      "4",
    ]);
    const report = testing.aggregateWorkerResults(
      options,
      [
        workerResult("spawnPipelineInMemory", 2),
        workerResult("spawnPipelineDurable", 2),
        workerResult("admission", 2),
        workerResult("recoverySweep", 4),
        workerResult("duplicateSuppression", 4),
      ],
      { rssStartBytes: 10, rssEndBytes: 20 },
    );

    expect(report).toMatchObject({
      schemaVersion: 2,
      options: { runs: 3, warmup: 1, fanout: [2], sweepRows: [4] },
      memory: {
        rssStartBytes: 10,
        rssEndBytes: 20,
        workerProcessMaxRssBytes: 150,
      },
      invariants: {
        ok: true,
        failures: [],
        spawnPipelineInMemory: true,
        spawnPipelineDurable: true,
        admissionCapOverflowRelease: true,
        sweepRecoveryRowsWithoutSessionEffects: true,
        dedupeNewestPerChild: true,
      },
    });
    expect(report.scenarios.spawnPipelineDurable[0]?.timingsMs).toEqual({
      count: 3,
      min: 1,
      p50: 2,
      max: 3,
    });
    expect(report.generatedAt).toEqual(expect.any(String));
  });

  it("reports deterministic parent progress around every worker", () => {
    const options = testing.parseOptions([
      "--runs",
      "3",
      "--warmup",
      "0",
      "--fanout",
      "2",
      "--sweep-rows",
      "4",
    ]);
    const progress: string[] = [];
    let now = 0;
    const report = testing.benchmark(options, {
      runWorker: (_options, scenario, size) => workerResult(scenario, size),
      writeProgress: (line) => progress.push(line),
      now: () => {
        const value = now;
        now += 250;
        return value;
      },
    });

    expect(report.invariants.ok).toBe(true);
    expect(progress).toHaveLength(10);
    expect(progress[0]).toBe(
      "[bench-agent-concurrency] worker 1/5 start scenario=spawnPipelineInMemory size=2",
    );
    expect(progress[1]).toBe(
      "[bench-agent-concurrency] worker 1/5 complete scenario=spawnPipelineInMemory size=2 elapsed=0.250s",
    );
    expect(progress.at(-2)).toBe(
      "[bench-agent-concurrency] worker 5/5 start scenario=duplicateSuppression size=4",
    );
    expect(progress.at(-1)).toBe(
      "[bench-agent-concurrency] worker 5/5 complete scenario=duplicateSuppression size=4 elapsed=0.250s",
    );
  });

  it("rejects incomplete synthetic worker sets", () => {
    const options = testing.parseOptions(["--fanout", "1", "--sweep-rows", "1"]);
    expect(() =>
      testing.aggregateWorkerResults(options, [workerResult("spawnPipelineInMemory", 1)]),
    ).toThrow("worker result mismatch");
  });

  it("rejects malformed, duplicate, mismatched, partial, and timed-out worker results", () => {
    const expected = { scenario: "admission" as const, size: 2, runs: 3 };
    const valid = workerResult("admission", 2);
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
        { status: 0, stdout: `${workerStdout(valid)}${workerStdout(valid)}`, stderr: "" },
        expected,
      ),
    ).toThrow("returned 2 result payloads");
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 0, stdout: workerStdout(workerResult("admission", 3)), stderr: "" },
        expected,
      ),
    ).toThrow("mismatched identity");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: `${WORKER_RESULT_SENTINEL}${JSON.stringify({ ...valid, memory: {} })}\n`,
          stderr: "",
        },
        expected,
      ),
    ).toThrow("memory.rssStartBytes");
    expect(() =>
      testing.parseWorkerProcessResult(
        {
          status: 0,
          stdout: workerStdout({ ...valid, timingsMs: [1, 2] }),
          stderr: "",
        },
        expected,
      ),
    ).toThrow("returned 2 samples; expected 3");
    const missingInvariant = structuredClone(valid);
    delete missingInvariant.invariant.admissionCap;
    expect(() =>
      testing.parseWorkerProcessResult(
        { status: 0, stdout: workerStdout(missingInvariant), stderr: "" },
        expected,
      ),
    ).toThrow("invariant.admissionCap is missing or invalid");
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

  it("supports help and ends failures with the marker", () => {
    const help = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-agent-concurrency.ts", "--help"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("OpenClaw agent concurrency benchmark");
    expect(help.stdout).toContain("--sweep-rows <list>");
    expect(help.stderr).toBe("");

    const failure = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/bench-agent-concurrency.ts", "--wat"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr.trim().split("\n").at(-1)).toBe(
      "[bench-agent-concurrency] FAILED (exit 1)",
    );
  });
});
