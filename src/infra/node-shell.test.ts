import { describe, expect, it } from "vitest";

import { buildNodeShellCommand } from "./node-shell.js";

describe("buildNodeShellCommand", () => {
  it("uses cmd.exe for win32", () => {
    expect(buildNodeShellCommand("echo hi", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
  });

  it("uses cmd.exe for windows labels", () => {
    expect(buildNodeShellCommand("echo hi", "windows")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(buildNodeShellCommand("echo hi", "Windows 11")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
  });

  it("uses /bin/sh for darwin", () => {
    expect(buildNodeShellCommand("echo hi", "darwin")).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });

  it("uses /bin/sh when platform missing", () => {
    expect(buildNodeShellCommand("echo hi")).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });
});
