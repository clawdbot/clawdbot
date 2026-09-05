import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  buildBenchmarkCommandEnv,
  buildBenchmarkSchedule,
  loadBenchmarkManifest,
  resolvePackageManagerIdentity,
  runOwnedCommand,
  validateBenchmarkManifest,
  VITEST_PAIR_HARNESS_DEADLINE_MS,
  withVitestPairDeadline,
  withTerminalManifest,
  writeJsonAtomic,
  type BenchmarkManifest,
  type BenchmarkRunRecord,
} from "../../scripts/lib/vitest-pair-benchmark.mts";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { waitForDead, waitForFile } from "../helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packageManager = {
  executable: "/opt/vitest-pair/pnpm",
  resolvedExecutable: "/opt/vitest-pair/pnpm",
  version: "12.1.0",
};

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
          packageManager,
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
        packageManager,
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

function writeExecutable(file: string, contents: string): void {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
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

  it("rejects selected workload byte mismatches between sides", () => {
    const baselineRoot = tempDirs.make("vitest-pair-baseline-inventory-");
    const candidateRoot = tempDirs.make("vitest-pair-candidate-inventory-");
    for (const lane of manifest.lanes) {
      for (const relative of inventoryPaths(lane)) {
        for (const root of [baselineRoot, candidateRoot]) {
          const file = path.join(root, relative);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, `${relative}\n`);
        }
      }
    }
    writeFileSync(path.join(candidateRoot, manifest.lanes[0]!.files[0]!), "changed workload\n");

    expect(() =>
      assertEquivalentInventories(
        assertInventoryAvailable(baselineRoot, manifest),
        assertInventoryAvailable(candidateRoot, manifest),
      ),
    ).toThrow("benchmark workload bytes differ");
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

  it.runIf(process.platform !== "win32")(
    "pins pnpm despite poisoned ambient pnpm and Corepack state",
    () => {
      const root = tempDirs.make("vitest-pair-pnpm-");
      const bin = path.join(root, "bin");
      const marker = path.join(root, "invocations.txt");
      const pinnedDir = path.join(root, "pinned");
      mkdirSync(bin);
      mkdirSync(pinnedDir);
      for (const name of ["pnpm", "corepack"]) {
        writeExecutable(
          path.join(bin, name),
          `#!/bin/sh\nprintf 'poison:${name}\\n' >> ${JSON.stringify(marker)}\nexit 97\n`,
        );
      }
      const pinned = path.join(pinnedDir, "pnpm");
      writeExecutable(
        pinned,
        `#!/bin/sh\nprintf 'pinned\\n' >> ${JSON.stringify(marker)}\nprintf '12.1.0\\n'\n`,
      );
      const ambientEnv = {
        ...process.env,
        COREPACK_HOME: path.join(root, "poison-corepack"),
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: path.join(bin, "pnpm"),
      };
      const identity = resolvePackageManagerIdentity(pinned, path.join(root, "probe"), ambientEnv);
      const cacheRoot = path.join(root, "run-cache");
      const env = buildBenchmarkCommandEnv(
        path.join(root, "home"),
        cacheRoot,
        identity,
        ambientEnv,
      );
      const runner = resolvePnpmRunner({ env, pnpmArgs: ["--version"] });
      const result = spawnSync(runner.command, runner.args, {
        encoding: "utf8",
        env,
        shell: runner.shell,
        windowsVerbatimArguments: runner.windowsVerbatimArguments,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("12.1.0");
      expect(identity).toStrictEqual({
        executable: pinned,
        resolvedExecutable: pinned,
        version: "12.1.0",
      });
      expect(env.npm_execpath).toBe(pinned);
      expect(env.COREPACK_HOME).toBe(path.join(cacheRoot, "corepack"));
      expect(readFileSync(marker, "utf8")).toBe("pinned\npinned\n");
    },
  );
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

  it.runIf(process.platform !== "win32")(
    "aborts the active child at the aggregate deadline and starts no successor",
    async () => {
      expect(VITEST_PAIR_HARNESS_DEADLINE_MS).toBe(165 * 60 * 1000);
      const root = tempDirs.make("vitest-pair-deadline-");
      const pidFile = path.join(root, "active.pid");
      const successor = path.join(root, "successor.txt");
      const output = path.join(root, "output");
      const activeScript = [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        withTerminalManifest(output, async () => {
          await withVitestPairDeadline(async (deadline) => {
            await expect(
              runOwnedCommand({
                bin: process.execPath,
                args: ["-e", activeScript],
                cwd: root,
                env: { PATH: process.env.PATH },
                logPath: path.join(root, "active.log"),
                deadline,
                timeoutMs: 10_000,
              }),
            ).rejects.toThrow("Vitest pair aggregate deadline exceeded");
            await expect(
              runOwnedCommand({
                bin: process.execPath,
                args: [
                  "-e",
                  `require("node:fs").writeFileSync(${JSON.stringify(successor)}, "started")`,
                ],
                cwd: root,
                env: { PATH: process.env.PATH },
                logPath: path.join(root, "successor.log"),
                deadline,
                timeoutMs: 10_000,
              }),
            ).rejects.toThrow("Vitest pair aggregate deadline exceeded");
          }, 500);
        }),
      ).rejects.toThrow("Vitest pair aggregate deadline exceeded");

      await waitForFile(pidFile, 3_000);
      await waitForDead(Number.parseInt(readFileSync(pidFile, "utf8"), 10), 5_000);
      expect(existsSync(successor)).toBe(false);
      expect(
        JSON.parse(readFileSync(path.join(output, "terminal-manifest.json"), "utf8")),
      ).toMatchObject({
        status: "failure",
        error: "Vitest pair aggregate deadline exceeded after 500ms",
      });
    },
  );

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
    "attributes recursive detached RSS without including an unrelated process",
    async () => {
      const root = tempDirs.make("vitest-pair-rss-");
      const unrelatedReady = path.join(root, "unrelated.ready");
      const unrelatedScript = [
        'const { writeFileSync } = require("node:fs");',
        "global.buffer = Buffer.alloc(192 * 1024 * 1024, 1);",
        `writeFileSync(${JSON.stringify(unrelatedReady)}, "ready");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const unrelated = spawn(process.execPath, ["-e", unrelatedScript], {
        detached: true,
        stdio: "ignore",
      });
      const unrelatedPid = unrelated.pid;
      if (!unrelatedPid) {
        throw new Error("unrelated memory process did not acquire a PID");
      }

      try {
        await waitForFile(unrelatedReady, 5_000);
        const wrapperPidFile = path.join(root, "wrapper.pid");
        const memoryPidFile = path.join(root, "memory.pid");
        const memoryReady = path.join(root, "memory.ready");
        const memoryScript = [
          'const { writeFileSync } = require("node:fs");',
          "global.buffer = Buffer.alloc(64 * 1024 * 1024, 1);",
          `writeFileSync(${JSON.stringify(memoryReady)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const wrapperScript = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          `const memory = spawn(process.execPath, ["-e", ${JSON.stringify(memoryScript)}], { detached: true, stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(memoryPidFile)}, String(memory.pid));`,
          "memory.unref();",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const rootScript = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          `const wrapper = spawn(process.execPath, ["-e", ${JSON.stringify(wrapperScript)}], { detached: true, stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(wrapperPidFile)}, String(wrapper.pid));`,
          "wrapper.unref();",
          "setTimeout(() => {}, 800);",
        ].join("\n");
        const samplePath = path.join(root, "samples.jsonl");

        await expect(
          runOwnedCommand({
            bin: process.execPath,
            args: ["-e", rootScript],
            cwd: root,
            env: { PATH: process.env.PATH },
            logPath: path.join(root, "output.log"),
            samplePath,
            timeoutMs: 10_000,
          }),
        ).rejects.toThrow("attributed descendants remained active");

        await waitForFile(memoryReady, 5_000);
        const wrapperPid = Number.parseInt(readFileSync(wrapperPidFile, "utf8"), 10);
        const memoryPid = Number.parseInt(readFileSync(memoryPidFile, "utf8"), 10);
        await waitForDead(wrapperPid, 5_000);
        await waitForDead(memoryPid, 5_000);
        expect(() => process.kill(unrelatedPid, 0)).not.toThrow();

        const samples = readFileSync(samplePath, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                processes: Array<{ pid: number; processGroup: number; rssBytes: number }>;
                rssBytes: number;
              },
          );
        expect(
          samples.some((sample) => sample.processes.some((entry) => entry.pid === wrapperPid)),
        ).toBe(true);
        expect(
          samples.some((sample) =>
            sample.processes.some(
              (entry) =>
                entry.pid === memoryPid &&
                entry.processGroup === memoryPid &&
                entry.rssBytes >= 64 * 1024 * 1024,
            ),
          ),
        ).toBe(true);
        expect(
          samples.every((sample) => sample.processes.every((entry) => entry.pid !== unrelatedPid)),
        ).toBe(true);
      } finally {
        try {
          process.kill(-unrelatedPid, "SIGKILL");
        } catch {}
        await waitForDead(unrelatedPid, 5_000);
      }
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
