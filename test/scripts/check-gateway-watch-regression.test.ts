import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendBoundedWatchLog,
  hasGatewayReadyLog,
  parseArgs,
  runTimedWatch,
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

  it("recognizes current and legacy gateway ready logs", () => {
    expect(hasGatewayReadyLog("[gateway] http server listening (0 plugins, 0.8s)")).toBe(true);
    expect(hasGatewayReadyLog("[gateway] ready (0 plugins, 0.8s)")).toBe(true);
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
          spawn: () => {
            process.nextTick(() => {
              child.emit("error", new Error("spawn failed"));
            });
            return child;
          },
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
      expect(waitForGatewayReady).not.toHaveBeenCalled();
      expect(stopChild).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
