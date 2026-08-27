// Test Live tests cover test live script behavior.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  buildTestLiveEnv,
  buildTestLivePnpmArgs,
  buildTestLiveSpawnParams,
  parseTestLiveArgs,
  resolveTestLiveHeartbeatMs,
} from "../../scripts/test-live.mts";

const posixIt = process.platform === "win32" ? it.skip : it;

describe("scripts/test-live", () => {
  it("parses wrapper flags before live test spawn", () => {
    const args = parseTestLiveArgs([
      "--codex-harness",
      "--no-quiet",
      "--",
      "src/gateway/gateway-codex-harness.live.test.ts",
      "--reporter=verbose",
    ]);

    expect(args).toEqual({
      forceCodexHarness: true,
      forwardedArgs: ["src/gateway/gateway-codex-harness.live.test.ts", "--reporter=verbose"],
      help: false,
      quietOverride: "0",
    });
    expect(buildTestLivePnpmArgs(args)).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "test/vitest/vitest.live.config.ts",
      "src/gateway/gateway-codex-harness.live.test.ts",
      "--reporter=verbose",
    ]);
  });

  it("preserves vitest flags after the passthrough separator", () => {
    const args = parseTestLiveArgs(["--quiet", "--", "--help", "--no-quiet", "--codex-harness"]);

    expect(args).toEqual({
      forceCodexHarness: false,
      forwardedArgs: ["--help", "--no-quiet", "--codex-harness"],
      help: false,
      quietOverride: "1",
    });
  });

  it("builds live env without mutating caller env", () => {
    const env = buildTestLiveEnv(
      { forceCodexHarness: true, forwardedArgs: [], help: false, quietOverride: undefined },
      {},
    );

    expect(env).toMatchObject({
      CI: "1",
      OPENCLAW_LIVE_CODEX_HARNESS: "1",
      OPENCLAW_LIVE_TEST: "1",
      OPENCLAW_LIVE_TEST_QUIET: "1",
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
      pnpm_config_verify_deps_before_run: "false",
    });
  });

  it("spawns live test children in a cleanup-friendly process group", () => {
    expect(buildTestLiveSpawnParams({ PATH: "/usr/bin" }, "darwin")).toEqual({
      detached: true,
      env: { PATH: "/usr/bin" },
      stdio: ["inherit", "pipe", "pipe"],
    });
    expect(buildTestLiveSpawnParams({ PATH: "/usr/bin" }, "win32")).toEqual({
      detached: false,
      env: { PATH: "/usr/bin" },
      stdio: ["inherit", "pipe", "pipe"],
    });
  });

  posixIt("signals the live pnpm child when the wrapper is terminated", async ({ signal }) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-test-live-signal-"));
    const fakePnpmPath = join(root, "pnpm");
    const signaledPath = join(root, "signaled");

    writeFakePnpm(fakePnpmPath);
    const runner = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/test-live.mts", "--", "fake.live.test.ts"],
      {
        env: {
          ...process.env,
          OPENCLAW_FAKE_PNPM_SIGNALED_PATH: signaledPath,
          npm_execpath: fakePnpmPath,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let childPid = 0;
    let descendantPid = 0;

    try {
      ({ childPid, descendantPid } = await waitForFixtureReady(runner, signal));

      expect(runner.pid).toBeGreaterThan(0);
      const completion = waitForClose(runner);
      process.kill(runner.pid!, "SIGTERM");
      const result = await completion;

      expect(result).toEqual({ code: null, signal: "SIGTERM" });
      await waitFor(() => fileExists(signaledPath), 5_000);
      expect(readFileSync(signaledPath, "utf8")).toBe("SIGTERM");
      await waitFor(() => !isProcessAlive(childPid), 5_000);
      await waitFor(() => !isProcessAlive(descendantPid), 5_000);
    } finally {
      await stopFixture(runner, [childPid, descendantPid]);
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("kills the live pnpm process group after the no-output timeout", async ({ signal }) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-test-live-timeout-"));
    const fakePnpmPath = join(root, "pnpm");
    const stderr: Buffer[] = [];

    writeFakePnpm(fakePnpmPath);
    // Advance the watchdog only after the real process group is ready; startup
    // latency must not race the short timeout that this test is exercising.
    const runner = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        [
          'import { mock } from "node:test";',
          'import { main } from "./scripts/test-live.mts";',
          'mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });',
          'process.once("message", () => {',
          "  mock.timers.tick(25);",
          "  mock.timers.tick(75);",
          "});",
          'main(["--", "fake.live.test.ts"]);',
        ].join("\n"),
      ],
      {
        env: {
          ...process.env,
          OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "25",
          OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "100",
          npm_execpath: fakePnpmPath,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    runner.stderr?.on("data", (chunk) => stderr.push(chunk));
    let childPid = 0;
    let descendantPid = 0;

    try {
      ({ childPid, descendantPid } = await waitForFixtureReady(runner, signal));

      const completion = waitForClose(runner);
      runner.send("advance-watchdog");
      expect(await completion).toEqual({ code: 1, signal: null });
      expect(Buffer.concat(stderr).toString("utf8")).toContain(
        "no output for 100ms; terminating stalled Vitest process group",
      );
      expect(Buffer.concat(stderr).toString("utf8")).toContain("[test:live] still running");
      await waitFor(() => !isProcessAlive(childPid), 5_000);
      await waitFor(() => !isProcessAlive(descendantPid), 5_000);
    } finally {
      await stopFixture(runner, [childPid, descendantPid]);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects loose heartbeat intervals instead of parsing prefixes", () => {
    expect(resolveTestLiveHeartbeatMs({})).toBe(20_000);
    expect(resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "2500" })).toBe(2500);
    expect(() => resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "1e3" })).toThrow(
      "invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 1e3",
    );
    expect(() =>
      resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "1000ms" }),
    ).toThrow("invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 1000ms");
    expect(() => resolveTestLiveHeartbeatMs({ OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: "0" })).toThrow(
      "invalid OPENCLAW_LIVE_WRAPPER_HEARTBEAT_MS: 0",
    );
  });

  it("prints help without spawning live Vitest", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/test-live.mts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node --import tsx scripts/test-live.mts");
    expect(result.stdout).not.toContain("Scope:");
    expect(result.stdout).not.toContain("pnpm");
    expect(result.stdout).not.toContain("[test:live]");
  });
});

function writeFakePnpm(filePath: string): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {',
      '  fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_SIGNALED_PATH, "SIGTERM");',
      "  process.exit(0);",
      "});",
      "const child = spawn(process.execPath, [",
      '  "-e",',
      "  [",
      "    \"process.on('SIGTERM', () => {});\",",
      '    "process.send(process.pid);",',
      '    "setInterval(() => {}, 1000);",',
      '  ].join("\\n"),',
      "], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      // Readiness certifies both signal handlers, not merely spawned processes.
      'child.once("message", (pid) => process.stdout.write(`${process.pid} ${pid}\\n`));',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodExecutable(filePath);
}

function chmodExecutable(filePath: string): void {
  chmodSync(filePath, 0o755);
}

async function waitForFixtureReady(runner: ReturnType<typeof spawn>, signal: AbortSignal) {
  if (!runner.stdout) {
    throw new Error("fixture readiness requires piped stdout");
  }
  signal.throwIfAborted();
  const lines = createInterface({ input: runner.stdout, signal });
  let spawnError: Error | undefined;
  const onError = (error: Error) => {
    spawnError = error;
    lines.close();
  };
  runner.once("error", onError);
  try {
    for await (const line of lines) {
      const [child, descendant] = line.split(" ");
      const childPid = Number(child);
      const descendantPid = Number(descendant);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      return { childPid, descendantPid };
    }
    throw spawnError ?? new Error("fixture closed before reporting readiness");
  } finally {
    runner.off("error", onError);
    lines.close();
  }
}

async function stopFixture(runner: ReturnType<typeof spawn>, pids: number[]) {
  try {
    if (runner.pid && isProcessAlive(runner.pid)) {
      const completion = waitForClose(runner);
      runner.kill("SIGTERM");
      await completion;
    }
  } finally {
    for (const pid of [runner.pid, ...pids]) {
      if (pid && isProcessAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for child close");
    }),
  ]);
}

function fileExists(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
