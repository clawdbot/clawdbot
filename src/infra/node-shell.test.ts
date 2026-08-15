// Covers platform shell argv construction.
import { describe, expect, it } from "vitest";
import { buildNodeShellCommand } from "./node-shell.js";

describe("buildNodeShellCommand", () => {
  it("uses cmd.exe for win-prefixed platform labels", () => {
    expect(buildNodeShellCommand("echo hi", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", "windows")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", " Windows 11 ")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
  });

  it("uses bindable non-login sh for macOS nodes", () => {
    expect(buildNodeShellCommand("echo hi", "darwin")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "macOS")).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "macOS 26.5.2")).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("retains login sh for other posix and missing platform values", () => {
    expect(buildNodeShellCommand("echo hi", "linux")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi")).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", null)).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(buildNodeShellCommand("echo hi", "   ")).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });
});
