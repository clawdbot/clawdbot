// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listPluginSdkDeclarationOutputs,
  pluginSdkEntrypoints,
} from "../../scripts/lib/plugin-sdk-entries.mjs";
import {
  computeArtifactInputsDigest,
  createPrefixedOutputWriter,
  derivePluginSdkTypeInputsFromBuildInfo,
  isArtifactSetFresh,
  parseMode,
  resolveBoundaryEntryShimRequiredOutputs,
  resolveBoundaryRootShimsTimeoutMs,
  resolveTsxImportSpecifier,
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
  it("derives the historical SDK cache misses from TypeScript build inputs", () => {
    const rootDir = makeTempDir(tempRoots, "openclaw-plugin-sdk-inputs-");
    const buildInfoPath = path.join(rootDir, "dist", "plugin-sdk", ".tsbuildinfo");
    fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
    fs.writeFileSync(
      buildInfoPath,
      JSON.stringify({
        fileNames: [
          "../../src/plugin-sdk/provider-auth.ts",
          "../../src/agents/cli-credentials.ts",
          "../../src/plugins/session-catalog.ts",
          "../../src/agents/embedded-agent-runner/run/types.ts",
        ],
        packageJsons: ["../../package.json"],
      }),
      "utf8",
    );

    const inputs = derivePluginSdkTypeInputsFromBuildInfo(buildInfoPath, rootDir);

    for (const historicalMiss of [
      "src/agents/cli-credentials.ts",
      "src/plugins/session-catalog.ts",
      "src/agents/embedded-agent-runner/run/types.ts",
    ]) {
      expect(
        inputs.some((input) => historicalMiss === input || historicalMiss.startsWith(`${input}/`)),
        historicalMiss,
      ).toBe(true);
      expect(inputs).not.toContain(historicalMiss);
    }
    expect(inputs).toContain("package.json");
  });

  it("resolves the tsx loader from the selected checkout toolchain", () => {
    const tsxBinPath = "/primary/node_modules/.bin/tsx";
    const loaderPath = "/primary/node_modules/tsx/dist/loader.mjs";

    expect(
      resolveTsxImportSpecifier({
        resolveTool: (toolName) => {
          expect(toolName).toBe("tsx");
          return tsxBinPath;
        },
        ensureToolchain: (toolPath) => {
          expect(toolPath).toBe(tsxBinPath);
          return "/worktree/node_modules";
        },
        createRequireFrom: (filename) => {
          expect(filename).toBe(tsxBinPath);
          return {
            resolve(packageName) {
              expect(packageName).toBe("tsx");
              return loaderPath;
            },
          };
        },
      }),
    ).toBe(pathToFileURL(loaderPath).href);
  });

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

  it("treats artifacts as fresh only when outputs are newer than inputs", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-prep-"));
    tempRoots.add(rootDir);
    const inputPath = path.join(rootDir, "src", "demo.ts");
    const outputPath = path.join(rootDir, "dist", "demo.tsbuildinfo");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(inputPath, "export const demo = 1;\n", "utf8");
    fs.writeFileSync(outputPath, "ok\n", "utf8");

    fs.utimesSync(inputPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(outputPath, new Date(2_000), new Date(2_000));

    expect(
      isArtifactSetFresh({
        rootDir,
        inputPaths: ["src"],
        outputPaths: ["dist/demo.tsbuildinfo"],
      }),
    ).toBe(true);

    fs.utimesSync(inputPath, new Date(3_000), new Date(3_000));

    expect(
      isArtifactSetFresh({
        rootDir,
        inputPaths: ["src"],
        outputPaths: ["dist/demo.tsbuildinfo"],
      }),
    ).toBe(false);
  });

  it("keeps mtime-stale artifacts fresh when the hash stamp matches the input digest", () => {
    // Regression: fresh checkouts re-stamp every input mtime, so cache-restored
    // artifacts must stay fresh by content identity, not build again per CI run.
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-hash-"));
    tempRoots.add(rootDir);
    const inputPath = path.join(rootDir, "src", "demo.ts");
    const stampPath = path.join(rootDir, "dist", ".demo.stamp");
    const outputPath = path.join(rootDir, "dist", "demo.d.ts");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(inputPath, "export const demo = 1;\n", "utf8");
    fs.writeFileSync(outputPath, "export declare const demo = 1;\n", "utf8");
    fs.writeFileSync(
      stampPath,
      `${computeArtifactInputsDigest({ rootDir, inputPaths: ["src"] })}\n`,
      "utf8",
    );

    // Simulate checkout: inputs newer than restored outputs, bytes unchanged.
    fs.utimesSync(stampPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(outputPath, new Date(1_000), new Date(1_000));
    const repairTimeMs = Date.now();
    fs.utimesSync(inputPath, repairTimeMs / 1_000, (repairTimeMs + 0.5) / 1_000);
    const freshParams = {
      rootDir,
      inputPaths: ["src"],
      outputPaths: ["dist/.demo.stamp", "dist/demo.d.ts"],
      hashStampPath: "dist/.demo.stamp",
    };

    vi.useFakeTimers();
    vi.setSystemTime(repairTimeMs);
    try {
      expect(isArtifactSetFresh(freshParams)).toBe(true);
      // The repaired output must clear the newest input by a whole millisecond.
      // Matching it exactly leaves no headroom for sub-millisecond write
      // rounding or lagging metadata, and a CI runner that lands even a
      // fraction short puts every later invocation back on the full-hash path.
      expect(fs.statSync(outputPath).mtimeMs).toBeGreaterThanOrEqual(
        Math.ceil(fs.statSync(inputPath).mtimeMs) + 1,
      );
    } finally {
      vi.useRealTimers();
    }

    fs.appendFileSync(inputPath, "export const demoTwo = 2;\n", "utf8");
    fs.utimesSync(outputPath, new Date(1_000), new Date(1_000));
    expect(isArtifactSetFresh(freshParams)).toBe(false);

    // Legacy timestamp stamps never satisfy the hash fallback.
    fs.writeFileSync(stampPath, `${new Date(5_000).toISOString()}\n`, "utf8");
    fs.utimesSync(stampPath, new Date(1_000), new Date(1_000));
    expect(isArtifactSetFresh(freshParams)).toBe(false);
  });

  it("requires generated entry-shim outputs in addition to the freshness stamp", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-entry-shims-"));
    tempRoots.add(rootDir);
    const inputPath = path.join(rootDir, "scripts", "write-plugin-sdk-entry-dts.ts");
    const stampPath = path.join(rootDir, "dist", "plugin-sdk", ".boundary-entry-shims.stamp");
    const rootDtsPath = path.join(rootDir, "dist", "plugin-sdk", "core.d.ts");
    const packageDtsPath = path.join(
      rootDir,
      "packages",
      "plugin-sdk",
      "dist",
      "src",
      "plugin-sdk",
      "core.d.ts",
    );

    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.mkdirSync(path.dirname(rootDtsPath), { recursive: true });
    fs.mkdirSync(path.dirname(packageDtsPath), { recursive: true });
    fs.writeFileSync(inputPath, "export {};\n", "utf8");
    fs.writeFileSync(stampPath, "ok\n", "utf8");
    fs.writeFileSync(rootDtsPath, "export {};\n", "utf8");
    fs.writeFileSync(packageDtsPath, "export {};\n", "utf8");

    fs.utimesSync(inputPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(stampPath, new Date(2_000), new Date(2_000));
    fs.utimesSync(rootDtsPath, new Date(2_000), new Date(2_000));
    fs.utimesSync(packageDtsPath, new Date(2_000), new Date(2_000));

    expect(
      isArtifactSetFresh({
        rootDir,
        inputPaths: ["scripts/write-plugin-sdk-entry-dts.ts"],
        outputPaths: [
          "dist/plugin-sdk/.boundary-entry-shims.stamp",
          "dist/plugin-sdk/core.d.ts",
          "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts",
        ],
      }),
    ).toBe(true);

    fs.rmSync(packageDtsPath);

    expect(
      isArtifactSetFresh({
        rootDir,
        inputPaths: ["scripts/write-plugin-sdk-entry-dts.ts"],
        outputPaths: [
          "dist/plugin-sdk/.boundary-entry-shims.stamp",
          "dist/plugin-sdk/core.d.ts",
          "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts",
        ],
      }),
    ).toBe(false);
    expect(resolveBoundaryEntryShimRequiredOutputs({})).toContain("dist/plugin-sdk/core.d.ts");
    expect(resolveBoundaryEntryShimRequiredOutputs({})).toContain(
      "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts",
    );
  });

  it("keeps bundled-private runtime shims in production while gating QA helpers", () => {
    const productionOutputs = resolveBoundaryEntryShimRequiredOutputs({});
    const privateQaOutputs = resolveBoundaryEntryShimRequiredOutputs({
      OPENCLAW_BUILD_PRIVATE_QA: "1",
    });

    expect(productionOutputs.filter((output) => output.startsWith("dist/plugin-sdk/"))).toEqual(
      listPluginSdkDeclarationOutputs().toSorted((a, b) => a.localeCompare(b)),
    );
    expect(privateQaOutputs.filter((output) => output.startsWith("dist/plugin-sdk/"))).toEqual(
      listPluginSdkDeclarationOutputs(pluginSdkEntrypoints).toSorted((a, b) => a.localeCompare(b)),
    );

    expect(productionOutputs).toContain("dist/plugin-sdk/provider-auth-runtime.d.ts");
    expect(productionOutputs).not.toContain("dist/plugin-sdk/test-fixtures.d.ts");
    expect(privateQaOutputs).toContain("dist/plugin-sdk/provider-auth-runtime.d.ts");
    expect(privateQaOutputs).toContain("dist/plugin-sdk/test-fixtures.d.ts");
    for (const entry of [
      "channel-contract-testing",
      "plugin-state-test-runtime",
      "plugin-test-runtime",
    ]) {
      expect(productionOutputs).not.toContain(`dist/plugin-sdk/${entry}.d.ts`);
      expect(privateQaOutputs).toContain(`dist/plugin-sdk/${entry}.d.ts`);
      expect(privateQaOutputs).toContain(`packages/plugin-sdk/dist/src/plugin-sdk/${entry}.d.ts`);
    }
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
