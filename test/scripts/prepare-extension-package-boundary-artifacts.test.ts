// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { spawn } from "node:child_process";
// Prepare Extension Package Boundary Artifacts tests cover prepare extension package boundary artifacts script behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPrefixedOutputWriter,
  isArtifactSetFresh,
  parseMode,
  resolveBoundaryRootShimsTimeoutMs,
  runNodeStep,
  runNodeSteps,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mjs";

const tempRoots = new Set<string>();

function createMockPipe() {
  const pipe = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  pipe.setEncoding = () => {};
  return pipe;
}

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

async function waitForFile(filePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await delay(25);
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
    await delay(25);
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
  const timeout = delay(timeoutMs).then(() => {
    throw new Error(`Process ${child.pid ?? "unknown"} did not exit after ${timeoutMs}ms`);
  });
  return Promise.race([exit, timeout]);
}

describe("prepare-extension-package-boundary-artifacts", () => {
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
          label: "fail-fast",
          args: ["--eval", "process.exit(2)"],
          timeoutMs: slowStepTimeoutMs,
        },
        {
          label: "slow-step",
          args: ["--eval", "setTimeout(() => {}, 60_000)"],
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

      try {
        const command = runNodeStepsInParallel([
          {
            label: "delayed-fail",
            args: ["--eval", "setTimeout(() => process.exit(2), 150)"],
            timeoutMs: 5_000,
          },
          {
            label: "abort-group-prep",
            args: ["--eval", parentScript],
            timeoutMs: 60_000,
          },
        ]);
        const expectedFailure = expect(command).rejects.toThrow(
          "delayed-fail failed with exit code 2",
        );
        await waitForFile(descendantPidPath, 1_000);
        descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);

        await expectedFailure;
        await waitForDead(descendantPid, 2_000);
      } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("hard-kills timed out prep steps", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals | number) => boolean;
      stderr: ReturnType<typeof createMockPipe>;
      stdout: ReturnType<typeof createMockPipe>;
    };
    child.stdout = createMockPipe();
    child.stderr = createMockPipe();
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };

    await expect(
      runNodeStep("hung-prep", ["--eval", "setTimeout(() => {}, 60_000)"], 5, {
        spawnImpl(command: string, args: string[]) {
          expect(command).toBe(process.execPath);
          expect(args).toEqual(["--eval", "setTimeout(() => {}, 60_000)"]);
          return child;
        },
      }),
    ).rejects.toThrow("hung-prep timed out after 5ms");

    expect(signals).toEqual(["SIGKILL"]);
  });

  it.runIf(process.platform !== "win32")("kills timed-out prep step process groups", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-timeout-group-"));
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
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const command = runNodeStep("hung-group-prep", ["--eval", parentScript], 750);
      const expectedFailure = expect(command).rejects.toThrow(
        "hung-group-prep timed out after 750ms",
      );
      await waitForFile(descendantPidPath, 500);
      descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);

      await expectedFailure;
      await waitForDead(descendantPid, 2_000);
    } finally {
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
      let runnerPid = 0;
      const moduleHref = pathToFileURL(
        path.resolve("scripts/prepare-extension-package-boundary-artifacts.mjs"),
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
        `await runNodeStep("signal-group-prep", ["--eval", ${JSON.stringify(parentScript)}], 60_000);`,
      ].join("\n");
      const runner = spawn(process.execPath, ["--input-type=module", "--eval", runnerScript], {
        stdio: "ignore",
      });
      runnerPid = runner.pid ?? 0;

      try {
        await waitForFile(descendantPidPath, 2_000);
        descendantPid = Number.parseInt(fs.readFileSync(descendantPidPath, "utf8"), 10);
        const runnerExit = waitForProcessExit(runner, 2_000);
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
