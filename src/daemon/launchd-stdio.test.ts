// Launchd stdio helpers must follow the installed plist, not the rewrite target.
import { describe, expect, it } from "vitest";
import { parseLaunchdPlistStdioPaths } from "./launchd-plist.js";
import { isLaunchdStdioSuppressed, resolveAdvertisedLaunchdStderr } from "./launchd-stdio.js";

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
    expect(isLaunchdStdioSuppressed("/dev/null")).toBe(true);
    expect(isLaunchdStdioSuppressed(null)).toBe(true);
    expect(resolveAdvertisedLaunchdStderr("/dev/null")).toEqual({ kind: "suppressed" });
    expect(resolveAdvertisedLaunchdStderr(null)).toEqual({ kind: "suppressed" });
  });
});
