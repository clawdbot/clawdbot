// Check Gateway Watch Regression tests cover check gateway watch regression script behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendBoundedWatchLog,
  collectGatewayWatchFindings,
  hasGatewayReadyLog,
  parseArgs,
  runTimedWatch,
  readNonNegativeInteger,
  shouldRefreshBuildStampForRestoredArtifacts,
  stopTimedWatchChild,
  updateWatchBuildDetection,
  WATCH_LOG_CAPTURE_MAX_CHARS,
  writeBuildAndRuntimePostBuildStamps,
} from "../../scripts/check-gateway-watch-regression.mjs";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata-paths.mjs";

describe("check-gateway-watch-regression", () => {
  it("accepts package-manager argument separators before script options", () => {
    expect(parseArgs(["--", "--window-ms", "1500", "--skip-build"])).toMatchObject({
      skipBuild: true,
      windowMs: 1500,
    });
  });

  it("parses timing and growth limits as strict non-negative integers", () => {
    expect(readNonNegativeInteger("0", "limit")).toBe(0);
    expect(readNonNegativeInteger(" 42 ", "limit")).toBe(42);
    expect(
      parseArgs([
        "--window-ms",
        "0",
        "--ready-timeout-ms",
        "1",
        "--ready-settle-ms",
        "2",
        "--sigkill-grace-ms",
        "3",
        "--sigkill-exit-grace-ms",
        "4",
        "--cpu-warn-ms",
        "5",
        "--cpu-fail-ms",
        "6",
        "--dist-runtime-file-growth-max",
        "7",
        "--dist-runtime-byte-growth-max",
        "8",
      ]),
    ).toMatchObject({
      cpuFailMs: 6,
      cpuWarnMs: 5,
      distRuntimeByteGrowthMax: 8,
      distRuntimeFileGrowthMax: 7,
      readySettleMs: 2,
      readyTimeoutMs: 1,
      sigkillExitGraceMs: 4,
      sigkillGraceMs: 3,
      windowMs: 0,
    });

    expect(() => readNonNegativeInteger("1.5", "limit")).toThrow(
      "limit must be a non-negative integer",
    );
    expect(() => readNonNegativeInteger("1e3", "limit")).toThrow(
      "limit must be a non-negative integer",
    );
    expect(() => readNonNegativeInteger("-1", "limit")).toThrow(
      "limit must be a non-negative integer",
    );
    expect(() => readNonNegativeInteger("9007199254740992", "limit")).toThrow(
      "limit must be a safe integer",
    );
    expect(() => parseArgs(["--window-ms", "soon"])).toThrow(
      "--window-ms must be a non-negative integer",
    );
  });

  it("recognizes current and legacy gateway ready logs", () => {
    expect(hasGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)")).toBe(true);
    expect(hasGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(true);
    expect(hasGatewayReadyLog("\u001B[36m[gateway]\u001B[39m \u001B[36mready\u001B[39m")).toBe(
      true,
    );
    expect(hasGatewayReadyLog("[gateway] starting HTTP server...")).toBe(false);
  });

  it("bounds in-memory watch output capture while keeping the newest logs", () => {
    const first = appendBoundedWatchLog("abc", "def", 8);
    expect(first).toEqual({ text: "abcdef", truncated: false });

    const second = appendBoundedWatchLog(first.text, "ghijkl", 8);
    expect(second).toEqual({ text: "efghijkl", truncated: true });
    expect(second.text).toHaveLength(8);
    expect(WATCH_LOG_CAPTURE_MAX_CHARS).toBeGreaterThan(1024);
  });

  it("keeps build-regression detection after diagnostic logs truncate", () => {
    const detected = updateWatchBuildDetection(
      { buffer: "", triggered: false, reason: null },
      "Building TypeScript (dist is stale: source_mtime_newer)\n",
    );
    const afterNoise = updateWatchBuildDetection(detected, "x".repeat(10_000));

    expect(afterNoise.triggered).toBe(true);
    expect(afterNoise.reason).toBe("source_mtime_newer");

    const coalesced = updateWatchBuildDetection(
      { buffer: "", triggered: false, reason: null },
      `Building TypeScript (dist is stale: config_newer)\n${"x".repeat(10_000)}`,
    );
    expect(coalesced.triggered).toBe(true);
    expect(coalesced.reason).toBe("config_newer");
  });

  it("fails the regression gate when gateway watch never becomes ready", () => {
    const findings = collectGatewayWatchFindings({
      cpuMs: 0,
      distRuntimeByteGrowth: 0,
      distRuntimeFileGrowth: 0,
      options: {
        cpuFailMs: 8000,
        cpuWarnMs: 1000,
        distRuntimeByteGrowthMax: 2 * 1024 * 1024,
        distRuntimeFileGrowthMax: 200,
        windowMs: 10_000,
      },
      watchBuildReason: null,
      watchResult: {
        idleCpuMs: 0,
        readyBeforeWindow: false,
        spawnError: null,
        timingFileMissing: false,
      },
      watchTriggeredBuild: false,
    });

    expect(findings.failures).toContain(
      "gateway:watch did not report ready before the idle CPU window",
    );
    expect(findings.warnings).toEqual([]);
  });

  it("refreshes restored build stamps only for skip-build config mtime drift", () => {
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: true,
        buildRequirement: { shouldBuild: true, reason: "config_newer" },
      }),
    ).toBe(true);
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: false,
        buildRequirement: { shouldBuild: true, reason: "config_newer" },
      }),
    ).toBe(false);
    expect(
      shouldRefreshBuildStampForRestoredArtifacts({
        skipBuild: true,
        buildRequirement: { shouldBuild: true, reason: "source_mtime_newer" },
      }),
    ).toBe(false);
  });

  it("refreshes runtime postbuild stamps after build stamps", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-watch-stamps-"));
    try {
      fs.mkdirSync(path.join(rootDir, ".git"), { recursive: true });
      writeBuildAndRuntimePostBuildStamps({ cwd: rootDir });

      const buildStampPath = path.join(rootDir, "dist", BUILD_STAMP_FILE);
      const runtimeStampPath = path.join(rootDir, "dist", RUNTIME_POSTBUILD_STAMP_FILE);
      expect(fs.existsSync(buildStampPath)).toBe(true);
      expect(fs.existsSync(runtimeStampPath)).toBe(true);
      expect(fs.statSync(runtimeStampPath).mtimeMs).toBeGreaterThanOrEqual(
        fs.statSync(buildStampPath).mtimeMs,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("bounds teardown when the watch process ignores termination signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();
    const killProcess = vi.fn();

    await expect(
      stopTimedWatchChild(
        child,
        1234,
        { sigkillExitGraceMs: 1, sigkillGraceMs: 1 },
        { killProcess },
      ),
    ).resolves.toEqual({ code: null, signal: "SIGKILL" });

    expect(killProcess).toHaveBeenNthCalledWith(1, 1234, "SIGTERM");
    expect(killProcess).toHaveBeenNthCalledWith(2, 1234, "SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("removes the isolated watch home after spawn failures", async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-watch-output-"));
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    const sleep = vi.fn(() => new Promise<never>(() => {}));
    const stopChild = vi.fn(
      () =>
        new Promise<never>(() => {
          // Spawn failures must win before cleanup waits for a child that never started.
        }),
    );
    const waitForGatewayReady = vi.fn(async () => false);
    const spawn = vi.fn(() => {
      process.nextTick(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    });

    try {
      const result = await runTimedWatch(
        {
          readySettleMs: 0,
          readyTimeoutMs: 0,
          sigkillGraceMs: 1,
          windowMs: 0,
        },
        outputDir,
        {
          allocateLoopbackPort: async () => 19042,
          spawn,
          sleep,
          stopTimedWatchChild: stopChild,
          waitForGatewayReady,
        },
      );

      const isolatedHomeDir = fs
        .readFileSync(path.join(outputDir, "watch.home.txt"), "utf8")
        .trim();
      expect(result.spawnError).toBe("spawn failed");
      expect(fs.existsSync(isolatedHomeDir)).toBe(false);
      expect(fs.existsSync(path.join(outputDir, "watch.home.txt"))).toBe(true);
      expect(spawn.mock.calls[0]?.[2]?.env?.OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS).toBe("0");
      expect(waitForGatewayReady).not.toHaveBeenCalled();
      expect(stopChild).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
