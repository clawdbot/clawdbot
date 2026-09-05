// Check Extension Package Tsc Boundary tests cover check extension package tsc boundary script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCanaryArtifactsForExtensions,
  formatBoundaryCheckSuccessSummary,
  formatSlowCompileSummary,
  formatSkippedCompileProgress,
  formatStepFailure,
  installCanaryArtifactCleanup,
  resolveCompileConcurrency,
  resolveCanaryArtifactPaths,
  runNodeStepAsync,
  runNodeStepsWithConcurrency,
} from "../../scripts/check-extension-package-tsc-boundary.mts";
import {
  isProcessAlive,
  waitForChildClose,
  waitForDead,
  waitForPidFile,
} from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";

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

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("check-extension-package-tsc-boundary", () => {
  it("reruns the real compiler after an inherited paths change in the CLI", () => {
    const root = fs.realpathSync(createTempExtensionRoot().rootDir);
    const write = (file: string, contents: string) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      fs.utimesSync(target, new Date(1000), new Date(1000));
    };
    write("package.json", '{"type":"module"}');
    write("pnpm-workspace.yaml", "packages: []\n");
    write("tsconfig.json", '{"compilerOptions":{"module":"NodeNext","strict":true,"types":[]}}');
    const pathsConfig = "extensions/tsconfig.package-boundary.paths.json";
    const config = {
      extends: "../tsconfig.json",
      compilerOptions: {
        paths: { "openclaw/plugin-sdk/*": ["../packages/plugin-sdk/dist/src/plugin-sdk/*.d.ts"] },
      },
    };
    write(pathsConfig, JSON.stringify(config));
    write(
      "extensions/tsconfig.package-boundary.base.json",
      '{"extends":"./tsconfig.package-boundary.paths.json","compilerOptions":{"rootDir":"${configDir}"}}',
    );
    write(
      "extensions/demo/tsconfig.json",
      '{"extends":"../tsconfig.package-boundary.base.json","include":["index.ts"]}',
    );
    write(
      "packages/plugin-sdk/dist/src/plugin-sdk/core.d.ts",
      "export type DemoContract = { ok: boolean };\n",
    );
    write(
      "extensions/demo/index.ts",
      'import type { DemoContract } from "openclaw/plugin-sdk/core";\nexport const demo: DemoContract = { ok: true };\n',
    );
    // Hold preparation fixed; scheduling, config parsing, and compilation remain real.
    write("scripts/prepare-extension-package-boundary-artifacts.mts", "export {};\n");
    for (const file of [
      "check-extension-package-tsc-boundary.mts",
      "tsx.mjs",
      "windows-cmd-helpers.mjs",
    ]) {
      write(`scripts/${file}`, fs.readFileSync(path.resolve("scripts", file), "utf8"));
    }
    for (const file of [
      "scripts/lib",
      "packages/normalization-core",
      ...["tsx", "typescript", "@typescript", "@openclaw/fs-safe", "p-map", ".bin/tsgo"].map(
        (name) => `node_modules/${name}`,
      ),
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.symlinkSync(path.resolve(file), path.join(root, file));
    }
    const run = () =>
      spawnSync(
        process.execPath,
        ["scripts/check-extension-package-tsc-boundary.mts", "--mode=compile"],
        { cwd: root, encoding: "utf8", timeout: 20_000 },
      );
    const cold = run();
    expect(cold.error, cold.stderr).toBeUndefined();
    expect(cold.status, cold.stdout + cold.stderr).toBe(0);
    expect(cold.stdout).toContain("compiled plugins: 1");
    const warm = run();
    expect(warm.status, warm.stdout + warm.stderr).toBe(0);
    expect(warm.stdout).toContain("compiled plugins: 0");
    expect(warm.stdout).toContain("skipped plugins: 1");
    config.compilerOptions.paths["openclaw/plugin-sdk/*"] = ["../missing-sdk/*.d.ts"];
    write(pathsConfig, JSON.stringify(config));
    const changed = run();
    expect(changed.error, changed.stderr).toBeUndefined();
    expect(changed.status, changed.stdout + changed.stderr).toBe(1);
    expect(changed.stderr).toContain("TS2307");
    expect(
      fs.existsSync(path.join(root, ".artifacts/extension-package-boundary/compile/demo.json")),
    ).toBe(false);
  }, 30_000);
  it("keeps matching canary diagnostics classified as a timeout when the compiler never exits", async () => {
    const diagnostic = "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts";
    await expect(
      runNodeStepAsync(
        "canary fixture",
        ["-e", `console.log(${JSON.stringify(diagnostic)});setInterval(()=>{},1000);`],
        2000,
      ),
    ).rejects.toMatchObject({ kind: "timeout", fullOutput: expect.stringContaining(diagnostic) });
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
    const failure = await runNodeStepAsync(
      "noisy-plugin",
      [
        "--eval",
        [
          "process.stdout.write('stdout-begin-' + 'x'.repeat(300000) + '-stdout-end');",
          "process.stderr.write('stderr-begin-' + 'y'.repeat(300000) + '-stderr-end');",
          "process.exitCode = 2;",
        ].join("\n"),
      ],
      20_000,
    ).then(
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

      const releaseAndWait = startProcessWatchdogFixture(() =>
        runNodeStepAsync("hung-step-group", ["--eval", parentScript], 100),
      );
      try {
        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(releaseAndWait()).rejects.toThrow("hung-step-group timed out after 100ms");
        await waitForDead(childPid, 2_000);
      } finally {
        await releaseAndWait().catch(() => undefined);
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
      const abortAckPath = path.join(root, "abort.ack");
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
      // fail-fast exits only after the test writes abort.ack, which happens
      // strictly after the child-alive assertion below. A time-based fuse here
      // races that assertion: a descheduled worker can observe the abort chain
      // already SIGKILLing the group. The step's 5s timeout bounds a wedged run.
      const failAfterTestAckScript = [
        "const fs = require('node:fs');",
        `const ackPath = ${JSON.stringify(abortAckPath)};`,
        "const wait = () => {",
        "  if (fs.existsSync(ackPath)) {",
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
              args: ["--eval", failAfterTestAckScript],
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

        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);
        fs.writeFileSync(abortAckPath, "go");

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
    async ({ signal }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-tsc-signal-"));
      tempRoots.add(root);
      const childPidPath = path.join(root, "child.pid");
      const readyPath = path.join(root, "child.ready");
      const scriptUrl = pathToFileURL(
        path.resolve("scripts/check-extension-package-tsc-boundary.mts"),
      ).href;
      let childPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        // Write the pid atomically: writeFileSync makes the file visible at open() (0 bytes)
        // before the content lands, so an existsSync-then-read poller can catch an empty file
        // and parse NaN. Rename only publishes the path once the pid is fully written.
        `const pidPath = ${JSON.stringify(childPidPath)};`,
        "fs.writeFileSync(pidPath + '.tmp', String(process.pid));",
        "fs.renameSync(pidPath + '.tmp', pidPath);",
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
        // Exercise cold startup beyond the former two-second readiness deadline.
        "await new Promise((resolve) => setTimeout(resolve, 3100));",
        `try { await runNodeStepAsync('parent-signal-step-group', ['--eval', ${JSON.stringify(
          parentScript,
        )}], 60_000); } catch { if (process.exitCode !== 143) process.exitCode = 1; }`,
      ].join("\n");

      const readiness = fs.watch(root);
      const runnerEnded = new AbortController();
      const readinessSignal = AbortSignal.any([signal, runnerEnded.signal]);
      try {
        runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });
        runner.once("exit", () => runnerEnded.abort(new Error("Runner exited before readiness")));
        runner.once("error", (error) => runnerEnded.abort(error));

        // Startup uses the test deadline; cleanup deadlines begin after SIGTERM.
        while (!fs.existsSync(readyPath) || !fs.existsSync(childPidPath)) {
          await once(readiness, "change", { signal: readinessSignal });
        }
        childPid = await waitForPidFile(childPidPath, 2_000);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner)).resolves.toEqual({
          code: 143,
          signal: null,
        });
        await waitForDead(childPid, 2_000);
      } finally {
        readiness.close();
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
