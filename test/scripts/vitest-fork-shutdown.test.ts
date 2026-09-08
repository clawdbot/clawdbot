import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, type TestContext } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import {
  isProcessAlive,
  waitForDead,
  waitForFile,
  waitForFixtureFile,
} from "../helpers/process-wait.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";
import { fixturePreloadArgs } from "./fixtures/ci-fixture-runtime.cjs";

const fixture = fileURLToPath(new URL("../fixtures/vitest-fork-shutdown.mjs", import.meta.url));
// Outside the enclosing Vitest TMPDIR: its owner must not erase retained writers.
const fixtureRoots = fileURLToPath(
  new URL("../../.artifacts/vitest-fork-shutdown/", import.meta.url),
);
fs.mkdirSync(fixtureRoots, { recursive: true });

function runJoinedShutdownTest(context: TestContext, body: () => Promise<void>) {
  // Register before the body starts: outer cancellation must join every continuation and finally.
  const run = Promise.resolve().then(() => {
    context.signal.throwIfAborted();
    return body();
  });
  context.onTestFinished(() => run);
  return run;
}

function expectReleasedNamespace(root: string) {
  if (process.platform !== "win32") {
    expect(
      fs.readdirSync(path.join(root, "tmp")),
      `Vitest retained temporary files in ${root}`,
    ).toEqual([]);
  }
}

async function runFixture(
  root: string,
  options: { scenario: string; setup: string; fail: boolean },
  nodeArgs: string[] = [],
  commandOptions: Pick<Parameters<typeof runVitestShutdownCommand>[0], "onReady" | "signal"> = {},
) {
  try {
    const result = await runVitestShutdownCommand({
      args: [...nodeArgs, fixture, root, JSON.stringify(options)],
      timeoutMs: 20_000,
      ...commandOptions,
    });
    if (result.code !== 0) {
      throw Object.assign(new Error(`Shutdown fixture exited with code ${result.code}`), result);
    }
    return result;
  } catch (error) {
    if (error instanceof Error) {
      const stdout = "stdout" in error ? String(error.stdout) : "";
      const stderr = "stderr" in error ? String(error.stderr) : "";
      error.message += `; retained fixture ${root}\n${stdout}\n${stderr}`;
    }
    throw error;
  }
}

it.for([
  { scenario: "slow-exit", setup: "shared", fail: false },
  { scenario: "slow-exit", setup: "env", fail: true },
  { scenario: "natural-exit", setup: "raw", fail: false },
  { scenario: "plain", setup: "shared", fail: false },
  { scenario: "threads", setup: "env", fail: false },
  { scenario: "vmForks", setup: "raw", fail: false },
  { scenario: "custom", setup: "raw", fail: false },
  { scenario: "custom-opt-in", setup: "raw", fail: false },
  { scenario: "hung-cleanup", setup: "shared", fail: false },
  { scenario: "hung-exit", setup: "shared", fail: false },
  { scenario: "bad-exit", setup: "shared", fail: false },
  { scenario: "forced", setup: "raw", fail: false },
])("joins $scenario shutdown with $setup setup (test failure: $fail)", (options, context) =>
  runJoinedShutdownTest(context, async () => {
    const tempDirs = createTempDirTracker();
    const root = tempDirs.make("vitest-fork-shutdown-", fixtureRoots);
    const { stdout } = await runFixture(root, options, [], { signal: context.signal });
    const result = JSON.parse(stdout);
    console.log(JSON.stringify({ root, options, ...result, output: undefined }));
    const { scenario, setup, fail } = options;
    if (scenario === "forced") {
      // Node uses TerminateProcess for TERM on Windows; POSIX exercises escalation.
      expect(result.signal).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
      expect(result.stopped).toBe(true);
      expect(isProcessAlive(result.workerPid)).toBe(false);
      expectReleasedNamespace(root);
      tempDirs.cleanup();
      return;
    }
    const brokenShutdown = scenario.startsWith("hung-") || scenario === "bad-exit";
    expect(result.code, result.output).toBe(fail || brokenShutdown ? 1 : 0);
    if (fail) {
      expect(result.output).toContain("intentional fixture failure");
    }
    expect(result.workerStopped).toBe(true);
    if (scenario === "threads") {
      expect(result.worker.threadId).toBeGreaterThan(0);
    } else {
      expect(result.worker.threadId).toBe(0);
    }
    if (setup !== "raw") {
      // Windows has no wrapper-owned group cleanup after a forced termination.
      // Its unfinished home is released after this test verifies the worker stopped.
      expect(result.homeRemoved).toBe(
        !(process.platform === "win32" && scenario === "hung-cleanup"),
      );
    }
    expect(result.callerPreserved).toBe(true);
    if (scenario.startsWith("hung-")) {
      // Advance the real stop deadline only after the worker reaches the hung boundary.
      expect(result.events).toContainEqual({ event: "deadline", delay: 60_000 });
      expect(result.output).toContain("Timeout waiting for worker to respond");
      expect(result.events.some((event: { event: string }) => event.event === "terminate")).toBe(
        true,
      );
    } else if (scenario === "bad-exit") {
      expect(result.output).toContain("Worker exited during graceful shutdown");
    } else if (scenario === "custom") {
      expect(result.output).toContain("1 passed");
      expect(result.events).toContainEqual({ event: "stopped-consumed" });
      expect(result.events).toContainEqual({ event: "parent-stop" });
      expect(result.events.some((event: { event: string }) => event.event === "deadline")).toBe(
        false,
      );
      expect(result.events).toContainEqual({ event: "terminate", signal: "SIGTERM" });
    } else if (scenario !== "plain") {
      expect(result.profiles.cpu, result.output).toBeGreaterThan(0);
      expect(result.profiles.heap, result.output).toBeGreaterThan(0);
      expect(result.events.some((event: { event: string }) => event.event === "terminate")).toBe(
        false,
      );
      if (scenario === "slow-exit") {
        expect(result.events).toContainEqual({ event: "home-removed" });
      }
    }
    // Only release after execution and shutdown assertions certify completion.
    expectReleasedNamespace(root);
    tempDirs.cleanup();
  }),
);

it.for([
  { maxBytes: undefined, limit: 2 * 1024 * 1024 },
  { maxBytes: 16 * 1024 * 1024, limit: 16 * 1024 * 1024 },
])("enforces the $limit byte output limit without accepting truncation", (options, context) =>
  runJoinedShutdownTest(context, async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      for (const excess of [0, 1]) {
        context.signal.throwIfAborted();
        let child!: ChildProcess;
        // Overflow must cancel a live writer; taskkill cannot certify a vanished leader.
        const keepAlive = excess ? "setInterval(() => {}, 1000);" : "";
        const command = runVitestShutdownCommand({
          args: [
            "-e",
            `${keepAlive}process.${stream}.write(Buffer.alloc(${options.limit + excess}, 120))`,
          ],
          maxBytes: options.maxBytes,
          signal: context.signal,
          onReady(owned) {
            child = owned;
          },
        });
        const proof = excess
          ? expect(command).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
          : command.then((result) => {
              expect(result.code).toBe(0);
              expect(Buffer.byteLength(result[stream], "utf8")).toBe(options.limit);
            });
        await proof;
        expect(child.stdout?.closed).toBe(true);
        expect(child.stderr?.closed).toBe(true);
      }
    }
  }),
);

it.runIf(process.platform !== "win32").for(["signal", "timeout"])(
  "rejects fixture cancellation by %s and joins descendants",
  (mode, context) =>
    runJoinedShutdownTest(context, async () => {
      const ownedDirs = createTempDirTracker();
      const root = ownedDirs.make("vitest-fork-cancellation-", fixtureRoots);
      const control = new URL("../fixtures/vitest-shutdown-cancellation.mjs", import.meta.url);
      const preload = path.join(root, "cancellation-preload.mjs");
      fs.writeFileSync(
        preload,
        `import {installVitestShutdownCancellation} from ${JSON.stringify(control.href)};
installVitestShutdownCancellation({root:${JSON.stringify(root)},preload:import.meta.url});
`,
      );
      let child!: ChildProcess;
      const invocation = runFixture(
        root,
        { scenario: "slow-exit", setup: "shared", fail: false },
        fixturePreloadArgs(preload),
        {
          onReady(owned) {
            child = owned;
          },
          signal: context.signal,
        },
      );
      const outcome = invocation.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      const pids: number[] = [];
      try {
        await waitForFixtureFile(path.join(root, "worker.pid"), invocation);
        const shim = Number(fs.readFileSync(path.join(root, "shim.pid"), "utf8"));
        const worker = Number(fs.readFileSync(path.join(root, "worker.pid"), "utf8"));
        context.signal.throwIfAborted();
        pids.push(shim, worker);
        process.kill(shim, "SIGSTOP");
        for (const pid of pids) {
          await expect
            .poll(() =>
              execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
                encoding: "utf8",
                timeout: 1_000,
              }).trim(),
            )
            .toMatch(/^T/);
        }
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
          encoding: "utf8",
          timeout: 1_000,
        })
          .trim()
          .split("\n")
          .map((row) => {
            const [pid, ppid, pgid] = row.trim().split(/\s+/).map(Number);
            return { pid: pid!, ppid: ppid!, pgid: pgid! };
          });
        const owned = new Set([child.pid!]);
        for (let previous = 0; previous !== owned.size;) {
          previous = owned.size;
          for (const row of rows) {
            if (owned.has(row.ppid)) {
              owned.add(row.pid);
            }
          }
        }
        expect(owned.has(shim) && owned.has(worker)).toBe(true);
        pids.splice(0, pids.length, ...owned);
        if (mode === "signal") {
          child.kill("SIGTERM");
        }
        const result = await outcome;
        await waitForFile(path.join(root, "term-received"), 1_000);
        console.log(
          JSON.stringify({
            mode,
            root,
            fixture: child.pid,
            pids,
            processes: rows.filter((row) => owned.has(row.pid)),
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            ...result,
          }),
        );
        expect(result.error).toMatchObject({
          code: mode === "timeout" ? "ETIMEDOUT" : 143,
        });
        expect(result.error).toMatchObject({
          stderr: expect.stringContaining("exit code 143"),
        });
        expect(pids.filter(isProcessAlive)).toEqual([]);
        expect(child.stdout?.closed).toBe(true);
        expect(child.stderr?.closed).toBe(true);
        expectReleasedNamespace(root);
        ownedDirs.cleanup();
      } finally {
        for (const pid of pids) {
          if (isProcessAlive(pid)) {
            process.kill(pid, "SIGCONT");
          }
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
        await outcome;
        for (const pid of pids) {
          await waitForDead(pid, 5_000);
        }
      }
    }),
);

it.runIf(process.platform !== "win32")(
  "rejects fixture cancellation by caller signal and joins descendants",
  (context) =>
    runJoinedShutdownTest(context, async () => {
      const ownedDirs = createTempDirTracker();
      const root = ownedDirs.make("managed-caller-signal-", fixtureRoots);
      const descendantPidPath = path.join(root, "descendant.pid");
      // Reuse the managed-owner tests' TERM-resistant tree and atomic ready PID.
      // This proves the shared helper boundary, not cold Vitest initialization.
      const descendantSource = `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  process.stdout.write("descendant-out\\n");
  process.stderr.write("descendant-err\\n");
});
setInterval(() => {}, 1000);
fs.writeFileSync(process.argv[1] + ".tmp", String(process.pid));
fs.renameSync(process.argv[1] + ".tmp", process.argv[1]);
`;
      const controller = new AbortController();
      let child!: ChildProcess;
      const invocation = runVitestShutdownCommand({
        args: [
          "-e",
          `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {
  process.stdout.write("leader-out\\n");
  process.stderr.write("leader-err\\n");
});
setInterval(() => {}, 1000);
spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, process.argv[1]], {
  stdio: ["ignore", "inherit", "inherit"],
});
`,
          descendantPidPath,
        ],
        timeoutMs: 20_000,
        signal: AbortSignal.any([context.signal, controller.signal]),
        onReady(owned) {
          child = owned;
        },
      });
      const outcome = invocation.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      try {
        await waitForFixtureFile(descendantPidPath, invocation);
        const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        if (!Number.isSafeInteger(descendantPid) || descendantPid <= 0) {
          throw new Error("Invalid descendant PID receipt");
        }
        context.signal.throwIfAborted();
        const childPid = child.pid!;
        const processes = execFileSync(
          "ps",
          ["-p", `${childPid},${descendantPid}`, "-o", "pid=,ppid=,pgid="],
          { encoding: "utf8", timeout: 1_000 },
        )
          .trim()
          .split("\n")
          .map((row) => {
            const [pid, ppid, pgid] = row.trim().split(/\s+/).map(Number);
            return { pid, ppid, pgid };
          });
        expect(processes).toEqual(
          expect.arrayContaining([
            { pid: childPid, ppid: process.pid, pgid: childPid },
            { pid: descendantPid, ppid: childPid, pgid: childPid },
          ]),
        );
        expect([childPid, descendantPid].every(isProcessAlive)).toBe(true);
        expect(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })).toBe("live");

        controller.abort();
        const result = await outcome;
        expect(result.error).toMatchObject({ code: "ABORT_ERR" });
        for (const role of ["leader", "descendant"]) {
          expect(result.error).toMatchObject({
            stdout: expect.stringContaining(`${role}-out\n`),
            stderr: expect.stringContaining(`${role}-err\n`),
          });
        }
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBe("SIGKILL");
        expect([childPid, descendantPid].filter(isProcessAlive)).toEqual([]);
        expect(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" })).toBe("dead");
        expect(child.stdout?.closed).toBe(true);
        expect(child.stderr?.closed).toBe(true);
        console.log(
          JSON.stringify({
            root,
            childPid,
            descendantPid,
            processes,
            signal: child.signalCode,
            ...result,
          }),
        );
      } finally {
        controller.abort();
        expect((await outcome).error).toMatchObject({ code: "ABORT_ERR" });
      }
      ownedDirs.cleanup();
    }),
);
