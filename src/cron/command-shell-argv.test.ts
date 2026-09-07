// Cron command payloads must persist a shell wrapper that can actually run on
// the gateway host platform; see register.cron-add and doctor payload migration.
import { describe, expect, it } from "vitest";
import { buildCronCommandShellArgv } from "./command-shell-argv.js";

describe("buildCronCommandShellArgv", () => {
  it("wraps commands in cmd.exe for win32 targets", () => {
    expect(buildCronCommandShellArgv("echo hi", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
  });

  it("keeps the POSIX sh wrapper for non-win32 targets", () => {
    expect(buildCronCommandShellArgv("echo hi", "linux")).toEqual(["sh", "-lc", "echo hi"]);
    expect(buildCronCommandShellArgv("echo hi", "darwin")).toEqual(["sh", "-lc", "echo hi"]);
  });
});
