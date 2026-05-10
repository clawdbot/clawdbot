import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireBoundaryCheckLock,
  cleanupCanaryArtifactsForExtensions,
  formatBoundaryCheckSuccessSummary,
  formatSlowCompileSummary,
  formatSkippedCompileProgress,
  formatStepFailure,
  installCanaryArtifactCleanup,
  isBoundaryCompileFresh,
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

afterEach(() => {
  for (const rootDir of tempRoots) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
  tempRoots.clear();
});

describe("check-extension-package-tsc-boundary", () => {
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
