// Daemon restart log tests cover restart log formatting and filtering.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendGatewayLifecycleAuditLog,
  renderCmdRestartLogSetup,
  renderPosixRestartLogSetup,
  resolveGatewayLogPaths,
  resolveGatewayRestartLogPath,
  resolveGatewaySupervisorLogPaths,
} from "./restart-logs.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("restart log conventions", () => {
  it("resolves profile-aware gateway logs and restart attempts together", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "work",
    };

    expect(resolveGatewayLogPaths(env)).toEqual({
      logDir: "/Users/test/.openclaw-work/logs",
      stdoutPath: "/Users/test/.openclaw-work/logs/gateway.log",
      stderrPath: "/Users/test/.openclaw-work/logs/gateway.err.log",
    });
    expect(resolveGatewayRestartLogPath(env)).toBe(
      "/Users/test/.openclaw-work/logs/gateway-restart.log",
    );
  });

  it("honors OPENCLAW_STATE_DIR for restart attempts", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
    };

    expect(resolveGatewayRestartLogPath(env)).toBe("/tmp/openclaw-state/logs/gateway-restart.log");
  });

  it("keeps macOS LaunchAgent stdout outside the state directory", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_STATE_DIR: "/Volumes/External/openclaw",
    };

    expect(resolveGatewaySupervisorLogPaths(env, { platform: "darwin" })).toEqual({
      logDir: "/Users/test/Library/Logs/openclaw",
      stdoutPath: "/Users/test/Library/Logs/openclaw/gateway.log",
      stderrPath: "/Users/test/Library/Logs/openclaw/gateway.err.log",
    });
    expect(resolveGatewayRestartLogPath(env)).toBe(
      "/Volumes/External/openclaw/logs/gateway-restart.log",
    );
  });

  it("keeps macOS LaunchAgent logs profile-aware in the shared user log directory", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_PROFILE: "work",
    };

    expect(resolveGatewaySupervisorLogPaths(env, { platform: "darwin" })).toEqual({
      logDir: "/Users/test/Library/Logs/openclaw",
      stdoutPath: "/Users/test/Library/Logs/openclaw/gateway-work.log",
      stderrPath: "/Users/test/Library/Logs/openclaw/gateway-work.err.log",
    });
  });

  it("renders best-effort POSIX log setup with escaped paths", () => {
    const setup = renderPosixRestartLogSetup({
      HOME: "/Users/test's",
    });

    expect(setup).toContain(
      "if mkdir -p '/Users/test'\\''s/.openclaw/logs' 2>/dev/null && : >>'/Users/test'\\''s/.openclaw/logs/gateway-restart.log' 2>/dev/null; then",
    );
    expect(setup).toContain("exec >>'/Users/test'\\''s/.openclaw/logs/gateway-restart.log' 2>&1");
  });

  it("renders CMD log setup with quoted paths", () => {
    const setup = renderCmdRestartLogSetup({
      USERPROFILE: "C:\\Users\\Test User",
    });

    expect(setup.quotedLogPath).toBe('"C:\\Users\\Test User/.openclaw/logs/gateway-restart.log"');
    expect(setup.lines).toContain(
      'if not exist "C:\\Users\\Test User/.openclaw/logs" mkdir "C:\\Users\\Test User/.openclaw/logs" >nul 2>&1',
    );
  });

  it("appends a profile-aware lifecycle audit line with stable key-value fields", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-audit-"));
    tempDirs.push(stateDir);

    appendGatewayLifecycleAuditLog(
      { OPENCLAW_STATE_DIR: stateDir },
      {
        action: "restart",
        source: "safe-rpc",
        mode: "deferred",
        pid: 4242,
        interactive: false,
      },
    );

    const line = fs.readFileSync(path.join(stateDir, "logs", "gateway-restart.log"), "utf8");
    expect(line).toMatch(/^\[[^\]]+\] openclaw gateway lifecycle /);
    expect(line).toContain("source=safe-rpc");
    expect(line).toContain("action=restart");
    expect(line).toContain("mode=deferred");
    expect(line).toContain("pid=4242");
    expect(line).toContain("interactive=0");
  });

  it("does not throw when lifecycle audit logging fails", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-audit-fail-"));
    tempDirs.push(stateDir);
    const blocker = path.join(stateDir, "not-a-directory");
    fs.writeFileSync(blocker, "block");

    expect(() =>
      appendGatewayLifecycleAuditLog(
        { OPENCLAW_STATE_DIR: path.join(blocker, "state") },
        {
          action: "stop",
          source: "cli",
          mode: "bootout",
          interactive: true,
        },
      ),
    ).not.toThrow();
  });
});
