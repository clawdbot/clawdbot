// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readArtifactRecord } from "../../scripts/lib/build-artifact-cache.mts";
import { BOUNDARY_PLUGIN_UNITS } from "../../scripts/lib/extension-boundary-inputs.mts";
import {
  createPrefixedOutputWriter,
  parseMode,
  resolveBoundaryRootShimsTimeoutMs,
  runNodeStep as runNodeStepImpl,
  runNodeSteps as runNodeStepsImpl,
  runNodeStepsInParallel as runNodeStepsInParallelImpl,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { prepareTsgoCommand } from "../../scripts/run-tsgo.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForChildClose, waitForDead } from "../helpers/process-wait.js";

const fixture = createFixtureLifetime();
const { createTempDir } = fixture;
afterEach(() => fixture.cleanup());

const runNodeStep = (...args: Parameters<typeof runNodeStepImpl>) =>
  fixture.track(runNodeStepImpl(...args));
const runNodeSteps = (...args: Parameters<typeof runNodeStepsImpl>) =>
  fixture.track(runNodeStepsImpl(...args));
const runNodeStepsInParallel = (...args: Parameters<typeof runNodeStepsInParallelImpl>) =>
  fixture.track(runNodeStepsInParallelImpl(...args));

async function waitForFile(
  filePath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    try {
      // writeFileSync is not atomic for concurrent readers: the path can exist
      // before the payload is flushed. Wait for non-empty content, or pid
      // parsing races into NaN under parallel-suite load.
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (content) {
        return content;
      }
    } catch {
      // Not created yet.
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("prepare-extension-package-boundary-artifacts", () => {
  it.for(["package-boundary", "all"])(
    "prunes only obsolete native declarations after success and repairs a failed partial emit (%s)",
    { timeout: 30_000 },
    (mode, { signal }) =>
      fixture.run(async () => {
        const root = fs.realpathSync(createTempDir("native-preparer-"));
        const write = (file: string, text: string) => {
          signal.throwIfAborted();
          const target = path.join(root, file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, text);
        };
        write("package.json", '{"name":"openclaw","type":"module"}');
        write("pnpm-workspace.yaml", "packages: []\n");
        write(
          "tsconfig.json",
          JSON.stringify({
            compilerOptions: {
              target: "es2023",
              module: "nodenext",
              skipLibCheck: true,
            },
          }),
        );
        write(
          "packages/plugin-sdk/tsconfig.json",
          JSON.stringify({
            extends: "../../tsconfig.json",
            include: ["../../src/**/*.ts"],
          }),
        );
        write("src/plugin-sdk/core.ts", 'export { value } from "../nested.js";');
        write("src/nested.ts", "export const value = 1;");
        write("scripts/lib/plugin-sdk-entrypoints.json", '["core"]');
        const copy = (file: string) => {
          const target = path.join(root, file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(path.resolve(file), target);
        };
        copy("scripts/prepare-extension-package-boundary-artifacts.mts");
        copy("scripts/lib/plugin-sdk-entries.mts");
        fs.cpSync(path.resolve("scripts/lib"), path.join(root, "scripts/lib"), { recursive: true });
        write("scripts/lib/plugin-sdk-entrypoints.json", '["core"]');
        for (const file of [
          "scripts/run-tsgo.mjs",
          "scripts/run-tsgo.mts",
          "scripts/tsx.mjs",
          "scripts/windows-cmd-helpers.mjs",
        ]) {
          copy(file);
        }
        for (const name of ["tsx", "typescript", "@typescript", "@openclaw/fs-safe", ".bin/tsgo"]) {
          const target = path.join(root, "node_modules", name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.symlinkSync(path.resolve("node_modules", name), target);
        }
        fs.symlinkSync(
          path.resolve("packages/normalization-core"),
          path.join(root, "packages/normalization-core"),
          process.platform === "win32" ? "junction" : undefined,
        );
        write(
          "packages/plugin-sdk/package.json",
          '{"name":"fixture-sdk","type":"module","types":"./dist/src/plugin-sdk/core.d.ts"}',
        );
        fs.symlinkSync(
          "../packages/plugin-sdk",
          path.join(root, "node_modules/fixture-sdk"),
          "dir",
        );
        const plugins = mode === "all" ? BOUNDARY_PLUGIN_UNITS : [];
        for (const [id, entry] of plugins) {
          write(
            `extensions/${id}/tsconfig.json`,
            JSON.stringify({ extends: "../../tsconfig.json", files: [`${entry}.ts`] }),
          );
          write(`extensions/${id}/${entry}.ts`, 'export { value } from "fixture-sdk";');
        }
        const recordPath = path.join(root, ".artifacts/extension-package-boundary/plugin-sdk.json");
        const output = "packages/plugin-sdk/dist";
        const run = async () => {
          signal.throwIfAborted();
          // Each phase gets a controller: the expected compiler failure aborts its
          // own command, while only test cancellation fences subsequent phases.
          const abortController = new AbortController();
          const abort = () => abortController.abort(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          try {
            await runNodeStep(
              "native-fixture",
              [
                path.join(root, "scripts/prepare-extension-package-boundary-artifacts.mts"),
                `--mode=${mode}`,
              ],
              30_000,
              { abortController },
            );
            signal.throwIfAborted();
          } finally {
            signal.removeEventListener("abort", abort);
          }
        };
        await run();
        const first = readArtifactRecord(recordPath)!;
        expect(first.outputs[`${output}/src/nested.d.ts`]).toBeDefined();
        write("src/plugin-sdk/core.ts", 'export { value } from "../renamed.js";');
        fs.renameSync(path.join(root, "src/nested.ts"), path.join(root, "src/renamed.ts"));
        write("src/renamed.ts", 'export const value: number = "error";');
        write(`${output}/orphan.d.ts`, "export {};");
        write(`${output}/operator-note.txt`, "unowned");
        await expect(run()).rejects.toThrow("failed with exit code 1");
        signal.throwIfAborted();
        expect(fs.existsSync(recordPath)).toBe(false);
        expect(fs.existsSync(path.join(root, output, "src/renamed.d.ts"))).toBe(true);
        expect(fs.existsSync(path.join(root, output, "src/nested.d.ts"))).toBe(true);
        write("src/renamed.ts", "export const value = 2;");
        await run();
        const repaired = readArtifactRecord(recordPath)!;
        expect(repaired.outputs[`${output}/src/renamed.d.ts`]).toBeDefined();
        expect(repaired.outputs[`${output}/src/nested.d.ts`]).toBeUndefined();
        expect(fs.existsSync(path.join(root, output, "src/nested.d.ts"))).toBe(false);
        expect(fs.existsSync(path.join(root, output, "orphan.d.ts"))).toBe(false);
        expect(fs.readFileSync(path.join(root, output, "operator-note.txt"), "utf8")).toBe(
          "unowned",
        );
        for (const [id, entry] of plugins) {
          const record = readArtifactRecord(
            path.join(root, `.artifacts/extension-package-boundary/${id}.json`),
          )!;
          expect(record.inputs).toContain(`${output}/src/renamed.d.ts`);
          expect(
            record.outputs[`.artifacts/extension-package-boundary/plugins/${id}/${entry}.d.ts`],
          ).toBeDefined();
        }
        fs.rmSync(path.join(root, output, "src/renamed.d.ts"));
        await run();
        expect(readArtifactRecord(recordPath)?.outputs).toEqual(repaired.outputs);
        const unchanged = fs.statSync(path.join(root, output, "src/renamed.d.ts")).mtimeMs;
        await run();
        expect(fs.statSync(path.join(root, output, "src/renamed.d.ts")).mtimeMs).toBe(unchanged);
      }),
  );
  it("prefixes each completed line and flushes the trailing partial line", () => {
    let output = "";
    const writer = createPrefixedOutputWriter("boundary", {
      write(chunk: string) {
        output += chunk;
      },
    });

    writer.write("first line\nsecond");
    writer.write(" line\nthird");
    writer.flush();

    expect(output).toBe("[boundary] first line\n[boundary] second line\n[boundary] third");
  });

  it(
    "aborts sibling steps after the first failure",
    () =>
      fixture.run(async () => {
        const startedAt = Date.now();
        const slowStepTimeoutMs = 60_000;
        const abortBudgetMs = 30_000;

        await expect(
          runNodeStepsInParallel([
            {
              label: "slow-step",
              args: ["--eval", "setTimeout(() => {}, 60_000)"],
              timeoutMs: slowStepTimeoutMs,
            },
            {
              label: "fail-fast",
              args: ["--eval", "process.exit(2)"],
              timeoutMs: slowStepTimeoutMs,
            },
          ]),
        ).rejects.toThrow("fail-fast failed with exit code 2");

        expect(Date.now() - startedAt).toBeLessThan(abortBudgetMs);
      }),
    45_000,
  );

  it.runIf(process.platform !== "win32")("force-kills aborted sibling step process groups", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-abort-group-");
      const descendantPidPath = path.join(rootDir, "descendant.pid");
      let descendantPid = 0;
      const descendantScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      // Fail the sibling only once the descendant reported its pid so the
      // group abort cannot race the descendant's boot under suite load.
      const failWhenDescendantReady = [
        "const fs = require('node:fs');",
        "setInterval(() => {",
        `  try { if (fs.readFileSync(${JSON.stringify(descendantPidPath)}, 'utf8').trim()) { process.exit(2); } } catch {}`,
        "}, 25);",
      ].join("\n");

      try {
        const command = runNodeStepsInParallel([
          {
            label: "delayed-fail",
            args: ["--eval", failWhenDescendantReady],
            timeoutMs: 30_000,
          },
          {
            label: "abort-group-prep",
            args: ["--eval", parentScript],
            abortKillGraceMs: 100,
            timeoutMs: 60_000,
          },
        ]);
        const expectedFailure = fixture.track(
          expect(command).rejects.toThrow("delayed-fail failed with exit code 2"),
        );
        descendantPid = Number.parseInt(await waitForFile(descendantPidPath, 10_000), 10);

        await expectedFailure;
        await waitForDead(descendantPid, 2_000);
      } finally {
        await fixture.verifyCleanup(async () => {
          if (descendantPid && isProcessAlive(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
            await waitForDead(descendantPid, 2_000);
          }
        });
      }
    }),
  );

  it
    .runIf(process.platform !== "win32")
    .for(["normal", "observation failure", "cancellation", "cleanup write failure"])(
    "lets aborted sibling descendants drain during kill grace (%s)",
    async (mode, { signal: contextSignal }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([contextSignal, controller.signal]);
      const observationFailure = new Error("drain observation failed");
      const originalNow = Date.now;
      const rootDir = createTempDir("openclaw-boundary-abort-drain-");
      let descendantPid = 0;
      let command: ReturnType<typeof runNodeStepsInParallel> | undefined;
      let outcome: Promise<unknown> | undefined;
      let rescue: Promise<void> | undefined;
      let joined = false;
      let requiredRescue = false;
      let heldAtRescue = false;
      const driver = fixture.run(async () => {
        const readyPath = path.join(rootDir, "descendant.ready");
        const drainedPath = path.join(rootDir, "descendant.drained");
        const failPath = path.join(rootDir, "fail");
        const terminatingPath = path.join(rootDir, "terminating");
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {",
          `  fs.writeFileSync(${JSON.stringify(terminatingPath)}, 'terminating');`,
          `  if (${JSON.stringify(mode)} !== 'normal') return;`,
          "  setTimeout(() => {",
          `    fs.writeFileSync(${JSON.stringify(drainedPath)}, 'drained');`,
          "    process.exit(0);",
          "  }, 50);",
          "});",
          `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const failWhenRequested = [
          "const fs = require('node:fs');",
          "setInterval(() => {",
          `  if (fs.existsSync(${JSON.stringify(failPath)})) process.exit(2);`,
          "}, 25);",
        ].join("\n");
        command = runNodeStepsInParallel([
          {
            label: "delayed-fail",
            args: ["--eval", failWhenRequested],
            timeoutMs: 30_000,
          },
          {
            label: "abort-group-drain",
            args: ["--eval", parentScript],
            abortKillGraceMs: 100,
            timeoutMs: 60_000,
          },
        ]);
        outcome = command
          .catch((error: unknown) => error)
          .finally(() => {
            joined = true;
          });
        const clock = vi.spyOn(Date, "now");
        const abort = () => clock.mockRestore();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
        try {
          descendantPid = Number(await waitForFile(readyPath, 10_000, signal));
          // Hold the supervisor's grace clock, not the real child's cleanup timer.
          // Separate force-kill tests cover expiry; this case proves graceful drain.
          clock.mockReturnValue(Date.now());
          fs.writeFileSync(failPath, "fail");
          if (mode !== "normal") {
            expect(await waitForFile(terminatingPath, 10_000, signal)).toBe("terminating");
            expect(isProcessAlive(descendantPid)).toBe(true);
            if (mode === "observation failure") {
              throw observationFailure;
            }
            if (mode === "cancellation") {
              controller.abort(observationFailure);
            }
          }
          if (mode !== "cleanup write failure") {
            expect(await waitForFile(drainedPath, 10_000, signal)).toBe("drained");
          }
        } finally {
          // Cleanup needs the supervisor's real deadline, including when a gate
          // write fails or the test is canceled before observing child drainage.
          clock.mockRestore();
          signal.removeEventListener("abort", abort);
          if (mode !== "normal") {
            // Diagnose the frozen-clock unwind before rescuing the real child.
            // The repaired finalizer must need no help on this next event-loop turn.
            rescue = new Promise<void>((resolve) => {
              setImmediate(() => {
                requiredRescue = Date.now !== originalNow;
                heldAtRescue = !joined && isProcessAlive(descendantPid) && fs.existsSync(rootDir);
                if (requiredRescue) {
                  clock.mockRestore();
                }
                resolve();
              });
            });
          }
          await fixture.verifyCleanup(async () => {
            try {
              fs.writeFileSync(mode === "cleanup write failure" ? rootDir : failPath, "fail");
            } finally {
              await outcome;
              if (descendantPid && isProcessAlive(descendantPid)) {
                process.kill(descendantPid, "SIGKILL");
                await waitForDead(descendantPid, 2_000);
              }
            }
          });
        }
      });
      const error = await driver.catch((failure: unknown) => failure);
      // The diagnostic rescue never substitutes for an actual command/group join.
      await rescue;
      await outcome;
      expect(isProcessAlive(descendantPid)).toBe(false);
      expect(fs.existsSync(rootDir)).toBe(true);
      expect(Date.now).toBe(originalNow);
      expect(getEventListeners(signal, "abort")).toEqual([]);
      if (mode === "cleanup write failure") {
        expect(error).toHaveProperty("code", "EISDIR");
        try {
          await expect(fixture.cleanup()).rejects.toThrow("Fixture cleanup unverified");
          expect(fs.existsSync(rootDir)).toBe(true);
        } finally {
          // Only the injected filesystem failure is disposable, after the real join.
          fs.rmSync(rootDir, { recursive: true, force: true });
        }
      } else if (mode === "normal") {
        await driver;
      } else {
        expect(error).toBe(observationFailure);
      }
      expect(command).toBeDefined();
      await expect(command).rejects.toThrow("delayed-fail failed with exit code 2");
      expect(requiredRescue, JSON.stringify({ heldAtRescue, joined })).toBe(false);
    },
  );

  it("clamps oversized prep step timers before scheduling", () =>
    fixture.run(async () => {
      await expect(
        runNodeStep(
          "slow-success",
          ["--eval", "setTimeout(() => process.exit(0), 25);"],
          MAX_TIMER_TIMEOUT_MS + 1,
        ),
      ).resolves.toBeUndefined();
    }));

  it.runIf(process.platform !== "win32").each(["spawn", "execFileSync"])(
    "joins timed-out prep groups launched with %s",
    (launch) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-timeout-group-");
        const descendantPidPath = path.join(rootDir, "descendant.pid");
        let descendantPid = 0;
        const nativeSetTimeout = globalThis.setTimeout;
        let triggerStepTimeout: (() => void) | undefined;
        const setTimeoutSpy = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((callback, timeout, ...args) => {
            if (timeout === 2_000 && !triggerStepTimeout) {
              triggerStepTimeout = () => callback(...args);
              return nativeSetTimeout(() => undefined, 60_000);
            }
            return nativeSetTimeout(callback, timeout, ...args);
          });
        const descendantScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        ].join("\n");
        const parentScript = [
          `const { ${launch} } = require('node:child_process');`,
          `${launch}(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });`,
          "setInterval(() => {}, 1000);",
        ].join("\n");

        const abortController = new AbortController();
        const command = runNodeStep("hung-group-prep", ["--eval", parentScript], 2_000, {
          abortController,
        });
        const expectedFailure = fixture.track(
          expect(command).rejects.toThrow("hung-group-prep timed out after 2000ms"),
        );
        const outcome = command.catch((error: unknown) => error);
        try {
          // The leaf publishes readiness after installing its signal handler. The
          // synchronous case matches the native CLI's fallback when execve is absent.
          descendantPid = Number.parseInt(await waitForFile(descendantPidPath, 4_000), 10);
          expect(triggerStepTimeout).toBeDefined();
          triggerStepTimeout?.();

          await expectedFailure;
          expect(isProcessAlive(descendantPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            abortController.abort();
            await outcome;
            setTimeoutSpy.mockRestore();
            if (descendantPid && isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
              await waitForDead(descendantPid, 2_000);
            }
          });
        }
      }),
  );

  it.runIf(process.platform !== "win32")(
    "forwards wrapper termination to detached prep step groups",
    () =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-signal-group-");
        const descendantPidPath = path.join(rootDir, "descendant.pid");
        let descendantPid = 0;
        const moduleHref = pathToFileURL(
          path.resolve("scripts/prepare-extension-package-boundary-artifacts.mts"),
        ).href;
        const descendantScript = [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const runnerScript = [
          `import { runNodeStep } from ${JSON.stringify(moduleHref)};`,
          `await runNodeStep("signal-group-prep", ["--eval", ${JSON.stringify(parentScript)}], 60_000, { abortKillGraceMs: 100 });`,
        ].join("\n");
        const runner = spawn(process.execPath, ["--input-type=module", "--eval", runnerScript], {
          stdio: "ignore",
        });
        const runnerPid = runner.pid ?? 0;
        const runnerClosed = fixture.track(once(runner, "close"));

        try {
          descendantPid = Number.parseInt(await waitForFile(descendantPidPath, 10_000), 10);
          const runnerExit = waitForChildClose(runner, 10_000);
          runner.kill("SIGTERM");

          expect(await runnerExit).toEqual({ code: 143, signal: null });
          expect(isProcessAlive(descendantPid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            if (runnerPid && isProcessAlive(runnerPid)) {
              runner.kill("SIGTERM");
            }
            await runnerClosed;
            if (descendantPid && isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
              await waitForDead(descendantPid, 2_000);
            }
          });
        }
      }),
  );

  it.runIf(process.platform !== "win32").each([0, 2])(
    "rejects and joins descendants left behind by a step exiting %s",
    (exitCode) =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-unjoined-");
        const pidFile = path.join(rootDir, "descendant.pid");
        const leafScript = `
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.send("ready");
process.disconnect();
`;
        const parentScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["--eval", ${JSON.stringify(leafScript)}], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
child.once("message", () => process.exit(${exitCode}));
`;
        try {
          await expect(
            runNodeStep("unjoined-prep", ["--eval", parentScript], 10_000),
          ).rejects.toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "terminated",
          });
          expect(isProcessAlive(Number(await waitForFile(pidFile, 2_000)))).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            if (fs.existsSync(pidFile)) {
              const pid = Number(fs.readFileSync(pidFile, "utf8"));
              if (pid && isProcessAlive(pid)) {
                process.kill(pid, "SIGKILL");
                await waitForDead(pid, 2_000);
              }
            }
          });
        }
      }),
  );

  it("does not admit work after sibling cancellation", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-canceled-");
      const startedPath = path.join(rootDir, "started");
      const abortController = new AbortController();
      abortController.abort();
      await expect(
        runNodeStep(
          "late-prep",
          ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started")`],
          1_000,
          { abortController },
        ),
      ).rejects.toThrow("canceled before starting");
      expect(fs.existsSync(startedPath)).toBe(false);
    }));

  it.runIf(process.platform !== "win32")(
    "keeps cancellation a failure when the child handles SIGTERM with exit zero",
    () =>
      fixture.run(async () => {
        const rootDir = createTempDir("openclaw-boundary-canceled-zero-");
        const readyPath = path.join(rootDir, "ready");
        const stoppedPath = path.join(rootDir, "stopped");
        const abortController = new AbortController();
        const script = [
          'const fs = require("node:fs");',
          `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stoppedPath)}, "zero"); process.exit(0); });`,
          `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const command = runNodeStep("canceled-zero", ["--eval", script], 10_000, {
          abortController,
        });
        const outcome = command.catch((error: unknown) => error);
        let pid = 0;
        try {
          pid = Number(await waitForFile(readyPath, 4_000));
          abortController.abort();
          await expect(command).rejects.toThrow("canceled-zero canceled after sibling failure");
          expect(fs.readFileSync(stoppedPath, "utf8")).toBe("zero");
          expect(isProcessAlive(pid)).toBe(false);
        } finally {
          await fixture.verifyCleanup(async () => {
            abortController.abort();
            await outcome;
            if (pid && isProcessAlive(pid)) {
              process.kill(pid, "SIGKILL");
              await waitForDead(pid, 2_000);
            }
          });
        }
      }),
  );

  it.each([false, true])("runs the declared compiler directly (invalid args=%s)", (invalid) =>
    fixture.run(async () => {
      const command = prepareTsgoCommand([invalid ? "--invalid-boundary-proof" : "--version"]);
      expect(command).not.toBeNull();
      if (!command) {
        throw new Error("compiler unexpectedly skipped");
      }
      const result = runNodeStep("compiler-prep", command.args, 10_000, command);
      if (invalid) {
        await expect(result).rejects.toThrow("compiler-prep failed with exit code 1");
      } else {
        await expect(result).resolves.toBeUndefined();
      }
    }),
  );

  it("runs boundary prep steps serially for local checks", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-serial-");
      const logPath = path.join(rootDir, "steps.log");
      const appendScript = (label: string) =>
        `const fs=require("node:fs");` +
        `const log=${JSON.stringify(logPath)};` +
        `fs.appendFileSync(log, ${JSON.stringify(`${label}-start\n`)});` +
        `setTimeout(()=>{fs.appendFileSync(log, ${JSON.stringify(`${label}-end\n`)});}, 50);`;

      await runNodeSteps(
        [
          { label: "first", args: ["--eval", appendScript("first")], timeoutMs: 5_000 },
          { label: "second", args: ["--eval", appendScript("second")], timeoutMs: 5_000 },
        ],
        { OPENCLAW_LOCAL_CHECK: "1" },
      );

      expect(fs.readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
        "first-start",
        "first-end",
        "second-start",
        "second-end",
      ]);
    }));

  it("passes step-specific environment overrides to child steps", () =>
    fixture.run(async () => {
      const rootDir = createTempDir("openclaw-boundary-env-");
      const outputPath = path.join(rootDir, "env.txt");
      const writeEnvScript =
        `const fs=require("node:fs");` +
        `fs.writeFileSync(${JSON.stringify(outputPath)}, process.env.OPENCLAW_TEST_ENV || "", "utf8");`;

      await runNodeStepsInParallel([
        {
          label: "env-step",
          args: ["--eval", writeEnvScript],
          env: { OPENCLAW_TEST_ENV: "passed" },
          timeoutMs: 5_000,
        },
      ]);

      expect(fs.readFileSync(outputPath, "utf8")).toBe("passed");
    }));

  it("parses prep mode and rejects unknown values", () => {
    expect(parseMode([])).toBe("all");
    expect(parseMode(["--mode=package-boundary"])).toBe("package-boundary");
    expect(() => parseMode(["--mode=nope"])).toThrow("Unknown mode: nope");
  });

  it("gives cold root shim generation macOS runner headroom", () => {
    expect(resolveBoundaryRootShimsTimeoutMs({})).toBe(300_000);
    expect(
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "450000",
      }),
    ).toBe(450_000);
    expect(() =>
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "120s",
      }),
    ).toThrow("OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS must be a positive integer");
    expect(() =>
      resolveBoundaryRootShimsTimeoutMs({
        OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS: "0",
      }),
    ).toThrow("OPENCLAW_PLUGIN_SDK_BOUNDARY_ROOT_SHIMS_TIMEOUT_MS must be a positive integer");
  });
});
