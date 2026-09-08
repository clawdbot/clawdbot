// Launchd stdio helpers must follow the installed plist, not the rewrite target.
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { parseLaunchdPlistStdioPaths } from "./launchd-plist.js";
import {
  formatLaunchdStderrRewriteGuidance,
  resolveAdvertisedLaunchdStderr,
} from "./launchd-stdio.js";

describe("launchd stdio advertisement", () => {
  it("reads StandardErrorPath from the persisted plist", () => {
    const parsed = parseLaunchdPlistStdioPaths(`
      <key>StandardOutPath</key>
      <string>/Users/test/Library/Logs/openclaw/gateway.log</string>
      <key>StandardErrorPath</key>
      <string>/Users/test/Library/Logs/openclaw/gateway.err.log</string>
    `);
    expect(parsed.stderrPath).toBe("/Users/test/Library/Logs/openclaw/gateway.err.log");
    expect(resolveAdvertisedLaunchdStderr(parsed.stderrPath)).toEqual({
      kind: "file",
      path: "/Users/test/Library/Logs/openclaw/gateway.err.log",
    });
  });

  it("treats /dev/null and a missing plist as suppressed", () => {
    expect(resolveAdvertisedLaunchdStderr("/dev/null")).toEqual({ kind: "suppressed" });
    expect(resolveAdvertisedLaunchdStderr(null)).toEqual({ kind: "suppressed" });
    expect(resolveAdvertisedLaunchdStderr("")).toEqual({ kind: "suppressed" });
  });

  it("points a loaded legacy LaunchAgent at rewrite-capable commands", () => {
    const guidance = formatLaunchdStderrRewriteGuidance({});
    expect(guidance).toContain(formatCliCommand("openclaw gateway restart"));
    expect(guidance).toContain(formatCliCommand("openclaw gateway install --force"));
    expect(guidance).not.toMatch(/openclaw gateway install(?! --force)/);
  });

  it("formats rewrite commands for the diagnosed service owner", () => {
    const guidance = formatLaunchdStderrRewriteGuidance(
      {},
      {
        restartCommand: "openclaw node restart",
        forceInstallCommand: "openclaw node install --force",
      },
    );
    expect(guidance).toContain(formatCliCommand("openclaw node restart"));
    expect(guidance).toContain(formatCliCommand("openclaw node install --force"));
    expect(guidance).not.toContain("openclaw gateway restart");
    expect(guidance).not.toContain("openclaw gateway install");
  });
});
