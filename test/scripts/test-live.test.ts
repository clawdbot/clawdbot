// Test Live tests cover test live script behavior.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  buildTestLiveEnv,
  buildTestLivePnpmArgs,
  buildTestLiveSpawnParams,
  parseTestLiveArgs,
  resolveTestLiveHeartbeatMs,
} from "../../scripts/test-live.mjs";

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

  posixIt("signals the live pnpm child when the wrapper is terminated", async () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-test-live-signal-"));
    const fakePnpmPath = join(root, "pnpm");
    const childPidPath = join(root, "child.pid");
    const signaledPath = join(root, "signaled");

    writeFakePnpm(fakePnpmPath);
    const runner = spawn(process.execPath, ["scripts/test-live.mjs", "--", "fake.live.test.ts"], {
      env: {
        ...process.env,
        OPENCLAW_FAKE_PNPM_PID_PATH: childPidPath,
        OPENCLAW_FAKE_PNPM_SIGNALED_PATH: signaledPath,
        npm_execpath: fakePnpmPath,
      },
      stdio: "ignore",
    });
    let childPid = 0;

    try {
      await waitFor(() => fileExists(childPidPath), 5_000);
      childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(Number.isInteger(childPid)).toBe(true);

      expect(runner.pid).toBeGreaterThan(0);
      process.kill(runner.pid!, "SIGTERM");
      const result = await waitForClose(runner);

      expect(result).toEqual({ code: null, signal: "SIGTERM" });
      await waitFor(() => fileExists(signaledPath), 5_000);
      expect(readFileSync(signaledPath, "utf8")).toBe("SIGTERM");
      await waitFor(() => !isProcessAlive(childPid), 5_000);
    } finally {
      if (runner.pid && isProcessAlive(runner.pid)) {
        process.kill(runner.pid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
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
    const result = spawnSync(process.execPath, ["scripts/test-live.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/test-live.mjs");
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
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_PID_PATH, String(process.pid));",
      'process.on("SIGTERM", () => {',
      '  fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_SIGNALED_PATH, "SIGTERM");',
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodExecutable(filePath);
}

function chmodExecutable(filePath: string): void {
  chmodSync(filePath, 0o755);
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(25);
  }
}

async function waitForClose(child: ReturnType<typeof spawn>, timeoutMs = 5_000) {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => {
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
