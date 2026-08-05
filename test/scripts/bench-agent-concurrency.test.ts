import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/bench-agent-concurrency.ts";

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

  it("summarizes min and nearest-rank percentiles", () => {
    expect(testing.summarizeTimings([100, 1, 4, 2, 3])).toEqual({
      count: 5,
      min: 1,
      p50: 3,
      p95: 100,
      p99: 100,
      max: 100,
    });
  });

  it("emits schema version 1, RSS, scenarios, and invariants in a tiny real smoke", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const report = await testing.benchmark(
      testing.parseOptions(["--runs", "1", "--warmup", "0", "--fanout", "2", "--sweep-rows", "2"]),
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      runtime: { node: process.version },
      options: { runs: 1, warmup: 0, fanout: [2], sweepRows: [2] },
      memory: {
        rssStartBytes: expect.any(Number),
        rssPeakBytes: expect.any(Number),
        rssEndBytes: expect.any(Number),
        rssDeltaBytes: expect.any(Number),
      },
      invariants: {
        ok: true,
        failures: [],
        admissionCapOverflowRelease: true,
        uniqueRegisteredRunsAndReleasedReservations: true,
        sweepRecoveryRowsWithoutSessionEffects: true,
        dedupeNewestPerChild: true,
      },
    });
    expect(process.env.NODE_ENV).toBe(previousNodeEnv);
    expect(report.generatedAt).toEqual(expect.any(String));
    expect(report.scenarios.spawnPipeline[0]?.timingsMs.count).toBe(1);
    expect(report.scenarios.recoverySweep[0]?.invariant).toMatchObject({
      seededRows: 6,
      removedRows: 4,
      retainedCurrent: 2,
      sessionEffects: 0,
      recoveryProjections: 2,
      lostContextCompletions: 0,
    });
    expect(report.scenarios.duplicateSuppression[0]?.invariant).toMatchObject({
      selectedRows: 2,
      newestSelected: true,
    });
  });

  it("supports native Node TypeScript help and ends failures with the marker", () => {
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
