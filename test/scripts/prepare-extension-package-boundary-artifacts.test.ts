// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  runNodeStep,
  runNodeSteps,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { makeTempDir } from "../helpers/temp-dir.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
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

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForDead(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(5);
  }
  throw new Error(`Process ${pid} was still alive after ${timeoutMs}ms`);
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = delay(timeoutMs, undefined, { ref: false }).then(() => {
    throw new Error(`Process ${child.pid ?? "unknown"} did not exit after ${timeoutMs}ms`);
  });
  return Promise.race([exit, timeout]);
}

describe("prepare-extension-package-boundary-artifacts", () => {
  it.each(["package-boundary", "all"])(
    "prunes only obsolete native declarations after success and repairs a failed partial emit (%s)",
    async (mode) => {
      const root = fs.realpathSync(makeTempDir(tempRoots, "native-preparer-"));
      const write = (file: string, text: string) => {
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
      fs.symlinkSync("../packages/plugin-sdk", path.join(root, "node_modules/fixture-sdk"), "dir");
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
      const run = () =>
        runNodeStep(
          "native-fixture",
          [
            path.join(root, "scripts/prepare-extension-package-boundary-artifacts.mts"),
            `--mode=${mode}`,
          ],
          30_000,
        );
      await run();
      const first = readArtifactRecord(recordPath)!;
      expect(first.outputs[`${output}/src/nested.d.ts`]).toBeDefined();
      write("src/plugin-sdk/core.ts", 'export { value } from "../renamed.js";');
      fs.renameSync(path.join(root, "src/nested.ts"), path.join(root, "src/renamed.ts"));
      write("src/renamed.ts", 'export const value: number = "error";');
      write(`${output}/orphan.d.ts`, "export {};");
      write(`${output}/operator-note.txt`, "unowned");
      await expect(run()).rejects.toThrow("failed with exit code 1");
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
      expect(fs.readFileSync(path.join(root, output, "operator-note.txt"), "utf8")).toBe("unowned");
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
    },
    30_000,
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

  it("aborts sibling steps after the first failure", async () => {
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
  }, 45_000);

  it.runIf(process.platform !== "win32")(
    "force-kills aborted sibling step process groups",
    async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-abort-group-"));
      tempRoots.add(rootDir);
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
        const expectedFailure = expect(command).rejects.toThrow(
          "delayed-fail failed with exit code 2",
        );
        descendantPid = Number.parseInt(await waitForFile(descendantPidPath, 10_000), 10);

        await expectedFailure;
        await waitForDead(descendantPid, 2_000);
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "lets aborted sibling descendants drain during kill grace",
    async () => {
      const rootDir = makeTempDir(tempRoots, "openclaw-boundary-abort-drain-");
      const readyPath = path.join(rootDir, "descendant.ready");
      const drainedPath = path.join(rootDir, "descendant.drained");
      const failPath = path.join(rootDir, "fail");
      const descendantScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {",
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
      const command = runNodeStepsInParallel([
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
      const outcome = command.catch((error: unknown) => error);
      const clock = vi.spyOn(Date, "now");
      let descendantPid = 0;
      try {
        descendantPid = Number(await waitForFile(readyPath, 10_000));
        // Hold the supervisor's grace clock, not the real child's cleanup timer.
        // Separate force-kill tests cover expiry; this case proves graceful drain.
        clock.mockReturnValue(Date.now());
        fs.writeFileSync(failPath, "fail");
        expect(await waitForFile(drainedPath, 10_000)).toBe("drained");
      } finally {
        clock.mockRestore();
        fs.writeFileSync(failPath, "fail");
        await outcome;
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
          await waitForDead(descendantPid, 2_000);
        }
      }
      await expect(command).rejects.toThrow("delayed-fail failed with exit code 2");
    },
  );

  it("clamps oversized prep step timers before scheduling", async () => {
    await expect(
      runNodeStep(
        "slow-success",
        ["--eval", "setTimeout(() => process.exit(0), 25);"],
        MAX_TIMER_TIMEOUT_MS + 1,
      ),
    ).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("kills timed-out prep step process groups", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-timeout-group-"));
    tempRoots.add(rootDir);
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
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const descendant = spawn(process.execPath, ["--eval", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      // The parent records the descendant pid at spawn time, before it
      // boots; fire the captured production timeout after that readiness proof.
      const command = runNodeStep("hung-group-prep", ["--eval", parentScript], 2_000);
      const expectedFailure = expect(command).rejects.toThrow(
        "hung-group-prep timed out after 2000ms",
      );
      descendantPid = Number.parseInt(await waitForFile(descendantPidPath, 4_000), 10);
      expect(triggerStepTimeout).toBeDefined();
      triggerStepTimeout?.();

      await expectedFailure;
      await waitForDead(descendantPid, 2_000);
    } finally {
      setTimeoutSpy.mockRestore();
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "forwards wrapper termination to detached prep step groups",
    async () => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-signal-group-"));
      tempRoots.add(rootDir);
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

      try {
        descendantPid = Number.parseInt(await waitForFile(descendantPidPath, 10_000), 10);
        const runnerExit = waitForProcessExit(runner, 10_000);
        runner.kill("SIGTERM");

        expect(await runnerExit).toEqual({ code: 143, signal: null });
        await waitForDead(descendantPid, 2_000);
      } finally {
        if (runnerPid && isProcessAlive(runnerPid)) {
          process.kill(runnerPid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("runs boundary prep steps serially for local checks", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-serial-"));
    tempRoots.add(rootDir);
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
  });

  it("passes step-specific environment overrides to child steps", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-env-"));
    tempRoots.add(rootDir);
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
  });

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
