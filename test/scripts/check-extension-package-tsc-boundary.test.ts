// Check Extension Package Tsc Boundary tests cover check extension package tsc boundary script behavior.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireBoundaryCheckLock,
  appendBoundedStepOutput,
  cleanupCanaryArtifactsForExtensions,
  formatBoundaryCheckSuccessSummary,
  formatSlowCompileSummary,
  formatSkippedCompileProgress,
  formatStepFailure,
  installCanaryArtifactCleanup,
  isBoundaryCompileFresh,
  resolveCompileConcurrency,
  resolveBoundaryCheckLockPath,
  resolveCanaryArtifactPaths,
  runNodeStepAsync,
  runNodeStepsWithConcurrency,
} from "../../scripts/check-extension-package-tsc-boundary.mjs";

const tempRoots = new Set<string>();

function createTempExtensionRoot(extensionId = "demo") {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-canary-"));
  tempRoots.add(rootDir);
  const extensionRoot = path.join(rootDir, "extensions", extensionId);
  fs.mkdirSync(extensionRoot, { recursive: true });
  return { rootDir, extensionRoot };
}

function writeCanaryArtifacts(rootDir: string, extensionId = "demo") {
  const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId, rootDir);
  fs.writeFileSync(canaryPath, "export {};\n", "utf8");
  fs.writeFileSync(tsconfigPath, '{ "extends": "./tsconfig.json" }\n', "utf8");
  return { canaryPath, tsconfigPath };
}

function createMockPipe() {
  const pipe = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: string) => void;
  };
  pipe.setEncoding = () => {};
  return pipe;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process still alive: ${pid}`);
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("check-extension-package-tsc-boundary", () => {
  it("keeps a bounded tail of captured step output", () => {
    const first = appendBoundedStepOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    const second = appendBoundedStepOutput(first, "ghij", 5);

    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  it("removes stale canary artifacts across extensions", () => {
    const { rootDir } = createTempExtensionRoot();
    const { canaryPath, tsconfigPath } = writeCanaryArtifacts(rootDir);

    cleanupCanaryArtifactsForExtensions(["demo"], rootDir);

    expect(fs.existsSync(canaryPath)).toBe(false);
    expect(fs.existsSync(tsconfigPath)).toBe(false);
  });

  it("cleans canary artifacts again on process exit", () => {
    const { rootDir } = createTempExtensionRoot();
    const { canaryPath, tsconfigPath } = writeCanaryArtifacts(rootDir);
    const processObject = new EventEmitter();
    const teardown = installCanaryArtifactCleanup(["demo"], { processObject, rootDir });

    processObject.emit("exit");
    teardown();

    expect(fs.existsSync(canaryPath)).toBe(false);
    expect(fs.existsSync(tsconfigPath)).toBe(false);
  });

  it("cleans stale artifacts for every extension id passed to the cleanup hook", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-canary-"));
    tempRoots.add(rootDir);
    fs.mkdirSync(path.join(rootDir, "extensions", "demo-a"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "extensions", "demo-b"), { recursive: true });
    const demoA = writeCanaryArtifacts(rootDir, "demo-a");
    const demoB = writeCanaryArtifacts(rootDir, "demo-b");
    const processObject = new EventEmitter();
    const teardown = installCanaryArtifactCleanup(["demo-a", "demo-b"], {
      processObject,
      rootDir,
    });

    processObject.emit("exit");
    teardown();

    expect(fs.existsSync(demoA.canaryPath)).toBe(false);
    expect(fs.existsSync(demoA.tsconfigPath)).toBe(false);
    expect(fs.existsSync(demoB.canaryPath)).toBe(false);
    expect(fs.existsSync(demoB.tsconfigPath)).toBe(false);
  });

  it("parses extension boundary compile concurrency strictly", () => {
    expect(resolveCompileConcurrency({ OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: "4" }, 32)).toBe(4);
    expect(resolveCompileConcurrency({}, 12)).toBe(6);
    expect(resolveCompileConcurrency({}, 3)).toBe(1);
    for (const value of ["4x", "0", "1e3"]) {
      expect(() =>
        resolveCompileConcurrency({ OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY: value }, 32),
      ).toThrow("OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY must be a positive integer");
    }
  });

  it("blocks concurrent boundary checks in the same checkout", () => {
    const { rootDir } = createTempExtensionRoot();
    const processObject = new EventEmitter();
    const release = acquireBoundaryCheckLock({ processObject, rootDir });

    let thrownError = null;
    try {
      acquireBoundaryCheckLock({ rootDir });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    if (!(thrownError instanceof Error)) {
      throw new Error("expected boundary lock contention to throw an Error");
    }
    expect(thrownError.message).toContain("kind: lock-contention");
    expect(thrownError.message).toContain(
      "another extension package boundary check is already running",
    );
    expect((thrownError as { fullOutput?: unknown }).fullOutput).toContain(
      "another extension package boundary check is already running",
    );
    expect((thrownError as { kind?: unknown }).kind).toBe("lock-contention");

    release();

    const lockPath = resolveBoundaryCheckLockPath(rootDir);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("summarizes long failure output with the useful tail", () => {
    const stdout = Array.from({ length: 45 }, (_, index) => `stdout ${index + 1}`).join("\n");
    const stderr = Array.from({ length: 3 }, (_, index) => `stderr ${index + 1}`).join("\n");

    const message = formatStepFailure("demo-plugin", {
      stdout,
      stderr,
      kind: "timeout",
      elapsedMs: 4_321,
      note: "demo-plugin timed out after 5000ms",
    });
    const messageLines = message.split("\n");

    expect(message).toContain("demo-plugin");
    expect(message).toContain("[... 5 earlier lines omitted ...]");
    expect(message).toContain("kind: timeout");
    expect(message).toContain("elapsed: 4321ms");
    expect(message).toContain("stdout 45");
    expect(messageLines).not.toContain("stdout 1");
    expect(message).toContain("stderr:\nstderr 1\nstderr 2\nstderr 3");
    expect(message).toContain("demo-plugin timed out after 5000ms");
  });

  it("formats a success summary with counts and elapsed time", () => {
    expect(
      formatBoundaryCheckSuccessSummary({
        mode: "all",
        compileCount: 84,
        skippedCompileCount: 13,
        canaryCount: 12,
        prepElapsedMs: 12_345,
        compileElapsedMs: 54_321,
        canaryElapsedMs: 6_789,
        elapsedMs: 54_321,
      }),
    ).toBe(
      [
        "extension package boundary check passed",
        "mode: all",
        "compiled plugins: 84",
        "skipped plugins: 13",
        "canary plugins: 12",
        "prep elapsed: 12345ms",
        "compile elapsed: 54321ms",
        "canary elapsed: 6789ms",
        "elapsed: 54321ms",
        "",
      ].join("\n"),
    );
  });

  it("omits phase timings that never ran", () => {
    expect(
      formatBoundaryCheckSuccessSummary({
        mode: "compile",
        compileCount: 97,
        skippedCompileCount: 0,
        canaryCount: 0,
        prepElapsedMs: 12_345,
        compileElapsedMs: 54_321,
        canaryElapsedMs: 0,
        elapsedMs: 66_666,
      }),
    ).toBe(
      [
        "extension package boundary check passed",
        "mode: compile",
        "compiled plugins: 97",
        "canary plugins: 0",
        "prep elapsed: 12345ms",
        "compile elapsed: 54321ms",
        "elapsed: 66666ms",
        "",
      ].join("\n"),
    );
  });

  it("formats skipped compile progress concisely", () => {
    expect(
      formatSkippedCompileProgress({
        skippedCount: 13,
        totalCount: 97,
      }),
    ).toBe("skipped 13 fresh plugin compiles before running 84 stale plugin checks\n");

    expect(
      formatSkippedCompileProgress({
        skippedCount: 97,
        totalCount: 97,
      }),
    ).toBe("skipped 97 fresh plugin compiles\n");
  });

  it("formats the slowest plugin compiles in descending order", () => {
    expect(
      formatSlowCompileSummary({
        compileTimings: [
          { extensionId: "quick", elapsedMs: 40 },
          { extensionId: "slow", elapsedMs: 900 },
          { extensionId: "medium", elapsedMs: 250 },
        ],
        limit: 2,
      }),
    ).toBe(["slowest plugin compiles:", "- slow: 900ms", "- medium: 250ms", ""].join("\n"));
  });

  it("treats a plugin compile as fresh only when its outputs are newer than plugin and shared sdk inputs", () => {
    const { rootDir, extensionRoot } = createTempExtensionRoot();
    const extensionSourcePath = path.join(extensionRoot, "index.ts");
    const extensionTsconfigPath = path.join(extensionRoot, "tsconfig.json");
    const stampPath = path.join(extensionRoot, "dist", ".boundary-tsc.stamp");
    const rootSdkTypePath = path.join(rootDir, "dist", "plugin-sdk", "core.d.ts");
    const packageSdkTypePath = path.join(
      rootDir,
      "packages",
      "plugin-sdk",
      "dist",
      "src",
      "plugin-sdk",
      "core.d.ts",
    );

    fs.mkdirSync(path.dirname(extensionSourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.mkdirSync(path.dirname(rootSdkTypePath), { recursive: true });
    fs.mkdirSync(path.dirname(packageSdkTypePath), { recursive: true });

    fs.writeFileSync(extensionSourcePath, "export const demo = 1;\n", "utf8");
    fs.writeFileSync(
      extensionTsconfigPath,
      '{ "extends": "../tsconfig.package-boundary.base.json" }\n',
      "utf8",
    );
    fs.writeFileSync(stampPath, "ok\n", "utf8");
    fs.writeFileSync(rootSdkTypePath, "export {};\n", "utf8");
    fs.writeFileSync(packageSdkTypePath, "export {};\n", "utf8");

    fs.utimesSync(extensionSourcePath, new Date(1_000), new Date(1_000));
    fs.utimesSync(extensionTsconfigPath, new Date(1_000), new Date(1_000));
    fs.utimesSync(rootSdkTypePath, new Date(500), new Date(500));
    fs.utimesSync(packageSdkTypePath, new Date(2_000), new Date(2_000));
    fs.utimesSync(stampPath, new Date(3_000), new Date(3_000));

    expect(isBoundaryCompileFresh("demo", { rootDir })).toBe(true);

    fs.utimesSync(rootSdkTypePath, new Date(500), new Date(500));
    fs.utimesSync(packageSdkTypePath, new Date(500), new Date(500));

    expect(isBoundaryCompileFresh("demo", { rootDir })).toBe(true);

    fs.utimesSync(rootSdkTypePath, new Date(4_000), new Date(4_000));

    expect(isBoundaryCompileFresh("demo", { rootDir })).toBe(false);
  });

  it("accepts cached input mtimes for freshness checks", () => {
    const { rootDir, extensionRoot } = createTempExtensionRoot();
    const extensionSourcePath = path.join(extensionRoot, "index.ts");
    const stampPath = path.join(extensionRoot, "dist", ".boundary-tsc.stamp");

    fs.mkdirSync(path.dirname(extensionSourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(extensionSourcePath, "export const demo = 1;\n", "utf8");
    fs.writeFileSync(stampPath, "ok\n", "utf8");

    fs.utimesSync(extensionSourcePath, new Date(1_000), new Date(1_000));
    fs.utimesSync(stampPath, new Date(3_000), new Date(3_000));

    expect(
      isBoundaryCompileFresh("demo", {
        rootDir,
        extensionNewestInputMtimeMs: 1_000,
        sharedNewestInputMtimeMs: 2_000,
      }),
    ).toBe(true);

    expect(
      isBoundaryCompileFresh("demo", {
        rootDir,
        extensionNewestInputMtimeMs: 1_000,
        sharedNewestInputMtimeMs: 4_000,
      }),
    ).toBe(false);
  });

  it("keeps full failure output on the thrown error for canary detection", async () => {
    const failure = await runNodeStepAsync(
      "demo-plugin",
      [
        "--eval",
        [
          "console.log('src/plugins/contracts/rootdir-boundary-canary.ts');",
          "for (let index = 1; index <= 45; index += 1) console.log(`stdout ${index}`);",
          "console.error('TS6059');",
          "process.exit(2);",
        ].join(" "),
      ],
      20_000,
    ).then(
      () => {
        throw new Error("expected demo-plugin step to fail");
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected failed canary step to reject with an Error");
    }
    expect(failure.message).toContain("[... 6 earlier lines omitted ...]");
    const failureMetadata = failure as {
      elapsedMs?: unknown;
      fullOutput?: unknown;
      kind?: unknown;
      status?: unknown;
    };
    expect(failureMetadata.fullOutput).toContain(
      "src/plugins/contracts/rootdir-boundary-canary.ts",
    );
    expect(failureMetadata.kind).toBe("nonzero-exit");
    expect(failureMetadata.status).toBeUndefined();
    const elapsedMs = failureMetadata.elapsedMs;
    expect(typeof elapsedMs).toBe("number");
    if (typeof elapsedMs !== "number") {
      throw new Error("expected failure elapsedMs to be a number");
    }
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("clamps oversized async node step timers before scheduling", async () => {
    await expect(
      runNodeStepAsync(
        "slow-success",
        ["--eval", "setTimeout(() => process.exit(0), 25);"],
        Number.MAX_SAFE_INTEGER,
      ),
    ).resolves.toMatchObject({
      stderr: "",
      stdout: "",
    });
  });

  it("keeps async node step failure output bounded", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals | number) => boolean;
      stderr: ReturnType<typeof createMockPipe>;
      stdout: ReturnType<typeof createMockPipe>;
    };
    child.stdout = createMockPipe();
    child.stderr = createMockPipe();
    child.kill = () => true;

    const failure = await runNodeStepAsync("noisy-plugin", ["--eval", "process.exit(2)"], 20_000, {
      spawnImpl() {
        setImmediate(() => {
          child.stdout.emit("data", `stdout-begin-${"x".repeat(300_000)}-stdout-end`);
          child.stderr.emit("data", `stderr-begin-${"y".repeat(300_000)}-stderr-end`);
          child.emit("close", 2);
        });
        return child;
      },
    }).then(
      () => {
        throw new Error("expected noisy-plugin step to fail");
      },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected failed noisy step to reject with an Error");
    }
    expect(failure.message).toContain("[output truncated");
    expect(failure.message).toContain("stdout-end");
    expect(failure.message).toContain("stderr-end");
    expect(failure.message).not.toContain("stdout-begin");
    expect(failure.message).not.toContain("stderr-begin");
    const fullOutput = (failure as { fullOutput?: unknown }).fullOutput;
    expect(typeof fullOutput).toBe("string");
    if (typeof fullOutput !== "string") {
      throw new Error("expected failure fullOutput to be a string");
    }
    expect(fullOutput.length).toBeLessThan(600_000);
  }, 30_000);

  it("hard-kills timed out async node steps", async () => {
    const processSignals: Array<[number, NodeJS.Signals | number | undefined]> = [];
    let processGroupAlive = true;
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals | number) => boolean;
      pid: number;
      stderr: ReturnType<typeof createMockPipe>;
      stdout: ReturnType<typeof createMockPipe>;
    };
    child.pid = 1234;
    child.stdout = createMockPipe();
    child.stderr = createMockPipe();
    child.kill = () => true;

    const failure = await runNodeStepAsync(
      "hung-plugin",
      ["--eval", "setTimeout(() => {}, 60_000)"],
      5,
      {
        spawnImpl(command: string, args: string[]) {
          expect(command).toBe(process.execPath);
          expect(args).toEqual(["--eval", "setTimeout(() => {}, 60_000)"]);
          return child;
        },
        killProcess(pid: number, signal?: NodeJS.Signals | number) {
          if (signal === "SIGKILL") {
            processGroupAlive = false;
          }
          if (signal === 0 && !processGroupAlive) {
            processSignals.push([pid, signal]);
            throw Object.assign(new Error("gone"), { code: "ESRCH" });
          }
          processSignals.push([pid, signal]);
          return true;
        },
        platform: "darwin",
      },
    ).then(
      () => {
        throw new Error("expected hung-plugin step to time out");
      },
      (error: unknown) => error,
    );

    expect(processSignals).toEqual([
      [-1234, "SIGKILL"],
      [-1234, 0],
    ]);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected timeout failure to reject with an Error");
    }
    expect(failure.message).toContain("hung-plugin timed out after 5ms");
    expect((failure as { kind?: unknown }).kind).toBe("timeout");
  });

  it.skipIf(process.platform === "win32")(
    "waits for timed-out async node step process groups",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-tsc-timeout-"));
      tempRoots.add(root);
      const childPidPath = path.join(root, "child.pid");
      let childPid = 0;
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");

      try {
        const failurePromise = runNodeStepAsync("hung-step-group", ["--eval", parentScript], 100, {
          spawnImpl(command: string, args: string[], options: unknown) {
            return spawn(command, args, options as Parameters<typeof spawn>[2]);
          },
        }).then(
          () => {
            throw new Error("expected hung-step-group to time out");
          },
          (error: unknown) => error,
        );

        await waitForFile(childPidPath, 2_000);
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
        expect(isProcessAlive(childPid)).toBe(true);

        const failure = await failurePromise;
        expect(failure).toBeInstanceOf(Error);
        await waitForDead(childPid, 2_000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it("aborts concurrent sibling steps after the first failure", async () => {
    const startedAt = Date.now();
    const slowStepTimeoutMs = 60_000;
    const abortBudgetMs = 30_000;

    await expect(
      runNodeStepsWithConcurrency(
        [
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
        ],
        2,
      ),
    ).rejects.toThrow("fail-fast");

    expect(Date.now() - startedAt).toBeLessThan(abortBudgetMs);
  }, 45_000);

  it.skipIf(process.platform === "win32")(
    "force-kills aborted async node step process groups",
    async () => {
      const { rootDir: root } = createTempExtensionRoot("abort-group");
      const childPidPath = path.join(root, "child.pid");
      let childPid = 0;
      const childScript = ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join(
        "",
      );
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const failAfterSiblingStartsScript = [
        "const fs = require('node:fs');",
        `const childPidPath = ${JSON.stringify(childPidPath)};`,
        "const deadlineAt = Date.now() + 2_000;",
        "const wait = () => {",
        "  if (fs.existsSync(childPidPath)) {",
        "    setTimeout(() => process.exit(2), 150);",
        "    return;",
        "  }",
        "  if (Date.now() >= deadlineAt) {",
        "    process.exit(2);",
        "    return;",
        "  }",
        "  setTimeout(wait, 10);",
        "};",
        "wait();",
      ].join("");

      try {
        const command = runNodeStepsWithConcurrency(
          [
            {
              label: "fail-fast",
              args: ["--eval", failAfterSiblingStartsScript],
              timeoutMs: 5_000,
            },
            {
              label: "aborted-step-group",
              args: ["--eval", parentScript],
              timeoutMs: 60_000,
            },
          ],
          2,
        );

        await waitForFile(childPidPath, 2_000);
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(command).rejects.toThrow("fail-fast");
        await waitForDead(childPid, 2_000);
      } finally {
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans active async node step descendants before forwarding parent SIGTERM",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-tsc-signal-"));
      tempRoots.add(root);
      const childPidPath = path.join(root, "child.pid");
      const readyPath = path.join(root, "child.ready");
      const scriptUrl = pathToFileURL(
        path.resolve("scripts/check-extension-package-tsc-boundary.mjs"),
      ).href;
      let childPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");
      const runnerScript = [
        `import { runNodeStepAsync } from ${JSON.stringify(scriptUrl)};`,
        `await runNodeStepAsync('parent-signal-step-group', ['--eval', ${JSON.stringify(
          parentScript,
        )}], 60_000);`,
      ].join("\n");

      try {
        runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });

        await waitForFile(readyPath, 2_000);
        await waitForFile(childPidPath, 2_000);
        childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForDead(childPid, 2_000);
      } finally {
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it("passes successful step timing metadata to onSuccess handlers", async () => {
    const elapsedTimes: number[] = [];

    await runNodeStepsWithConcurrency(
      [
        {
          label: "demo-step",
          args: ["--eval", "process.exit(0)"],
          timeoutMs: 20_000,
          onSuccess(result: { elapsedMs: number }) {
            elapsedTimes.push(result.elapsedMs);
          },
        },
      ],
      1,
    );

    expect(elapsedTimes).toHaveLength(1);
    expect(elapsedTimes[0]).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
