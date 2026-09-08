// Daemon runtime hint tests cover platform-specific daemon guidance.
import { describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints } from "./runtime-hints.js";

const { readPersistedLaunchdStderrPath } = vi.hoisted(() => ({
  readPersistedLaunchdStderrPath: vi.fn(() => null as string | null),
}));

vi.mock("./launchd-stdio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./launchd-stdio.js")>();
  return {
    ...actual,
    readPersistedLaunchdStderrPath,
  };
});

describe("buildPlatformRuntimeLogHints", () => {
  it("does not invent gateway.err.log when the LaunchAgent plist is missing", () => {
    readPersistedLaunchdStderrPath.mockReturnValue(null);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          HOME: "/Users/test",
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
          OPENCLAW_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "Launchd stdout (if installed): /Users/test/Library/Logs/openclaw/gateway.log",
      `Launchd stderr (if installed): suppressed (/dev/null). Rewrite the LaunchAgent with ${formatCliCommand("openclaw gateway restart")} or ${formatCliCommand("openclaw gateway install --force")}.`,
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
  });

  it("does not invent gateway.err.log when the LaunchAgent still discards stderr", () => {
    readPersistedLaunchdStderrPath.mockReturnValue("/dev/null");
    const hints = buildPlatformRuntimeLogHints({
      platform: "darwin",
      env: {
        HOME: "/Users/test",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
        OPENCLAW_LOG_PREFIX: "gateway",
      },
      systemdServiceName: "openclaw-gateway",
      windowsTaskName: "OpenClaw Gateway",
    });
    expect(hints[1]).toContain("suppressed (/dev/null)");
    expect(hints[1]).not.toContain("gateway.err.log");
  });

  it("uses Node rewrite commands for a suppressed Node LaunchAgent", () => {
    readPersistedLaunchdStderrPath.mockReturnValue("/dev/null");
    const hints = buildPlatformRuntimeLogHints({
      platform: "darwin",
      env: {
        HOME: "/Users/test",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
        OPENCLAW_LOG_PREFIX: "node",
      },
      systemdServiceName: "openclaw-node",
      windowsTaskName: "OpenClaw Node",
      rewriteCommands: {
        restartCommand: "openclaw node restart",
        forceInstallCommand: "openclaw node install --force",
      },
    });
    expect(hints[1]).toContain(formatCliCommand("openclaw node restart"));
    expect(hints[1]).toContain(formatCliCommand("openclaw node install --force"));
    expect(hints[1]).not.toContain("openclaw gateway restart");
    expect(hints[1]).not.toContain("openclaw gateway install");
  });

  it("advertises the persisted LaunchAgent stderr path after rewrite", () => {
    readPersistedLaunchdStderrPath.mockReturnValue(
      "/Users/test/Library/Logs/openclaw/gateway.err.log",
    );
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          HOME: "/Users/test",
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
          OPENCLAW_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "Launchd stdout (if installed): /Users/test/Library/Logs/openclaw/gateway.log",
      "Launchd stderr (if installed): /Users/test/Library/Logs/openclaw/gateway.err.log",
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
  });

  it("renders systemd and windows hints by platform", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "linux",
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "Logs: journalctl --user -u openclaw-gateway.service -n 200 --no-pager",
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "win32",
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      'Logs: schtasks /Query /TN "OpenClaw Gateway" /V /FO LIST',
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
  });
});

describe("buildPlatformServiceStartHints", () => {
  it("builds platform-specific service start hints", () => {
    expect(
      buildPlatformServiceStartHints({
        platform: "darwin",
        installHint: "openclaw gateway install",
        startCommand: "openclaw gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "openclaw gateway install",
      "openclaw gateway",
      "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.openclaw.gateway.plist",
    ]);
    expect(
      buildPlatformServiceStartHints({
        platform: "linux",
        installHint: "openclaw gateway install",
        startCommand: "openclaw gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "OpenClaw Gateway",
      }),
    ).toEqual([
      "openclaw gateway install",
      "openclaw gateway",
      "systemctl --user start openclaw-gateway.service",
    ]);
  });
});
