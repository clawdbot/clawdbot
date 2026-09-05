import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeBenchmark,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  buildBenchmarkSchedule,
  loadBenchmarkManifest,
  runOwnedCommand,
  validateBenchmarkManifest,
  withTerminalManifest,
  writeJsonAtomic,
  type BenchmarkManifest,
  type BenchmarkRunRecord,
} from "../../scripts/lib/vitest-pair-benchmark.mts";
import { waitForDead, waitForFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const manifest: BenchmarkManifest = {
  version: 1,
  rounds: 7,
  thresholds: {
    overallWallRatio: 1.1,
    criticalLaneWallRatio: 1.15,
    criticalLaneRssRatio: 1.2,
    coldWallRatio: 1.2,
    improvementRatio: 0.95,
    improvementPairCount: 5,
  },
  lanes: [
    { id: "core", critical: true, config: "test/core.config.ts", files: ["src/core.test.ts"] },
    {
      id: "gateway",
      critical: true,
      config: "test/gateway.config.ts",
      files: ["src/gateway.test.ts"],
    },
    { id: "ui", critical: true, config: "test/ui.config.ts", files: ["ui/view.test.ts"] },
    {
      id: "lifecycle",
      critical: true,
      files: ["test/scripts/lifecycle.test.ts"],
    },
  ],
};

function recordsFor(candidateRatio: number | ((lane: string) => number)): BenchmarkRunRecord[] {
  const ratioFor = typeof candidateRatio === "function" ? candidateRatio : () => candidateRatio;
  const records: BenchmarkRunRecord[] = [];
  for (const lane of manifest.lanes) {
    for (let round = 1; round <= manifest.rounds; round += 1) {
      const pair = `measured-${round}-${lane.id}`;
      for (const side of ["baseline", "candidate"] as const) {
        const ratio = side === "candidate" ? ratioFor(lane.id) : 1;
        records.push({
          id: `${pair}-${side}`,
          phase: "measured",
          side,
          lane: lane.id,
          round,
          pair,
          cacheMode: "warm",
          command: ["node"],
          startedAt: "2026-09-05T00:00:00.000Z",
          durationMs: 100 * ratio,
          userCpuMs: 50,
          systemCpuMs: 10,
          peakRssBytes: 1_000 * ratio,
          processSampleCount: 2,
          exitCode: 0,
        });
      }
    }
    for (const side of ["baseline", "candidate"] as const) {
      const ratio = side === "candidate" ? ratioFor(lane.id) : 1;
      records.push({
        id: `cold-${lane.id}-${side}`,
        phase: "cold",
        side,
        lane: lane.id,
        round: null,
        pair: `cold-${lane.id}`,
        cacheMode: "fresh",
        command: ["node"],
        startedAt: "2026-09-05T00:00:00.000Z",
        durationMs: 100 * ratio,
        userCpuMs: 50,
        systemCpuMs: 10,
        peakRssBytes: 1_000 * ratio,
        processSampleCount: 2,
        exitCode: 0,
      });
    }
  }
  return records;
}

function inventoryPaths(lane: BenchmarkManifest["lanes"][number]): string[] {
  return [...(lane.config ? [lane.config] : []), ...lane.files];
}

function gatewayRegressionRatio(lane: string): number {
  return new Map([["gateway", 1.3]]).get(lane) ?? 1;
}

describe("Vitest pair benchmark contract", () => {
  it("keeps the committed representative inventory valid and available", () => {
    const committed = loadBenchmarkManifest("scripts/vitest-pair-benchmark-lanes.json");
    expect(committed.lanes.map((lane) => lane.id)).toStrictEqual([
      "core-unit",
      "gateway-core",
      "ui-jsdom",
      "worker-lifecycle",
    ]);
    expect(assertInventoryAvailable(process.cwd(), committed).inventorySha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it("rejects malformed and duplicate inventories", () => {
    expect(() => validateBenchmarkManifest({ ...manifest, rounds: 6 })).toThrow(
      "exactly seven measured rounds",
    );
    expect(() =>
      validateBenchmarkManifest({
        ...manifest,
        lanes: [...manifest.lanes, manifest.lanes[0]],
      }),
    ).toThrow("duplicate benchmark lane id");
    expect(() =>
      validateBenchmarkManifest({
        ...manifest,
        lanes: [{ ...manifest.lanes[0], files: ["../escape.test.ts"] }, ...manifest.lanes.slice(1)],
      }),
    ).toThrow("normalized repository-relative path");
  });

  it("requires every committed inventory path on both sides", () => {
    const root = tempDirs.make("vitest-pair-inventory-");
    for (const lane of manifest.lanes) {
      for (const relative of inventoryPaths(lane)) {
        const file = path.join(root, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${relative}\n`);
      }
    }
    const inventory = assertInventoryAvailable(root, manifest);
    expect(inventory.entries).toHaveLength(7);
    expect(inventory.inventorySha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rotates lane order and alternates paired side order", () => {
    const schedule = buildBenchmarkSchedule(manifest);
    const measured = schedule.filter((entry) => entry.phase === "measured");
    expect(measured.slice(0, 8).map((entry) => `${entry.lane.id}:${entry.side}`)).toStrictEqual([
      "core:baseline",
      "core:candidate",
      "gateway:baseline",
      "gateway:candidate",
      "ui:baseline",
      "ui:candidate",
      "lifecycle:baseline",
      "lifecycle:candidate",
    ]);
    expect(measured.slice(8, 16).map((entry) => `${entry.lane.id}:${entry.side}`)).toStrictEqual([
      "gateway:candidate",
      "gateway:baseline",
      "ui:candidate",
      "ui:baseline",
      "lifecycle:candidate",
      "lifecycle:baseline",
      "core:candidate",
      "core:baseline",
    ]);
    expect(schedule.filter((entry) => entry.phase === "warmup")).toHaveLength(8);
    expect(schedule.filter((entry) => entry.phase === "cold")).toHaveLength(8);
  });

  it("refuses reruns before a benchmark child can start", () => {
    expect(() => assertSingleWorkflowAttempt("1")).not.toThrow();
    expect(() => assertSingleWorkflowAttempt("2")).toThrow("dispatch a fresh run");
  });

  it("fails critical regressions and avoids noisy improvement claims", () => {
    const regression = analyzeBenchmark(recordsFor(gatewayRegressionRatio), manifest);
    expect(regression.verdict).toBe("regression");
    expect(regression.regressions).toStrictEqual(
      expect.arrayContaining([expect.stringContaining("gateway median paired wall ratio")]),
    );

    const neutral = analyzeBenchmark(recordsFor(0.98), manifest);
    expect(neutral.verdict).toBe("pass");
    expect(neutral.performance).toBe("no-material-change");
    expect(neutral.claim).toContain("No broad improvement claim");

    const improved = analyzeBenchmark(recordsFor(0.9), manifest);
    expect(improved.verdict).toBe("pass");
    expect(improved.performance).toBe("improved");
  });
});

describe("Vitest pair benchmark lifecycle", () => {
  it("persists terminal failure and atomically replaces JSON state", async () => {
    const root = tempDirs.make("vitest-pair-terminal-");
    const state = path.join(root, "state.json");
    writeJsonAtomic(state, { generation: 1 });
    writeJsonAtomic(state, { generation: 2 });
    expect(JSON.parse(readFileSync(state, "utf8"))).toStrictEqual({ generation: 2 });

    await expect(
      withTerminalManifest(root, async () => {
        throw new Error("injected benchmark failure");
      }),
    ).rejects.toThrow("injected benchmark failure");
    expect(
      JSON.parse(readFileSync(path.join(root, "terminal-manifest.json"), "utf8")),
    ).toMatchObject({
      status: "failure",
      error: "injected benchmark failure",
    });
  });

  it.runIf(process.platform !== "win32")("does not retry a failed benchmark child", async () => {
    const root = tempDirs.make("vitest-pair-no-retry-");
    const attempts = path.join(root, "attempts.txt");
    const script = [
      'const { appendFileSync } = require("node:fs");',
      `appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");`,
      "process.exit(7);",
    ].join("\n");

    const result = await runOwnedCommand({
      bin: process.execPath,
      args: ["-e", script],
      cwd: root,
      env: { PATH: process.env.PATH },
      logPath: path.join(root, "output.log"),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(7);
    expect(readFileSync(attempts, "utf8")).toBe("attempt\n");
  });

  it.runIf(process.platform !== "win32")(
    "fails closed and cleans a leaked descendant process",
    async () => {
      const root = tempDirs.make("vitest-pair-leak-");
      const pidFile = path.join(root, "child.pid");
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("\n");

      await expect(
        runOwnedCommand({
          bin: process.execPath,
          args: ["-e", script],
          cwd: root,
          env: { PATH: process.env.PATH },
          logPath: path.join(root, "output.log"),
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow(/process group remained active|cleanup could not verify/u);

      await waitForFile(pidFile, 3_000);
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      await waitForDead(pid, 5_000);
    },
  );

  it.runIf(process.platform === "linux")(
    "uses GNU time labels understood by the hosted Linux runner",
    () => {
      const result = spawnSync("/usr/bin/time", ["--version"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("GNU time");
    },
  );
});
