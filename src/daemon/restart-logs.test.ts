import { describe, expect, it } from "vitest";
import {
  GATEWAY_RESTART_LOG_FILENAME,
  renderCmdRestartLogSetup,
  renderPosixRestartLogSetup,
  resolveGatewayLogPaths,
  resolveGatewayRestartLogPath,
} from "./restart-logs.js";

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
      `/Users/test/.openclaw-work/logs/${GATEWAY_RESTART_LOG_FILENAME}`,
    );
  });

  it("honors OPENCLAW_STATE_DIR for restart attempts", () => {
    const env = {
      HOME: "/Users/test",
      OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
    };

    expect(resolveGatewayRestartLogPath(env)).toBe(
      `/tmp/openclaw-state/logs/${GATEWAY_RESTART_LOG_FILENAME}`,
    );
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
});
