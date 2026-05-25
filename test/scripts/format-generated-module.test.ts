import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGeneratedModuleFormatter } from "../../scripts/lib/format-generated-module.mjs";

describe("resolveGeneratedModuleFormatter", () => {
  it("uses the direct formatter binary on non-Windows when available", () => {
    const formatterPath = path.join("/repo", "node_modules", ".bin", "oxfmt");

    expect(
      resolveGeneratedModuleFormatter({
        existsSync: (value) => value === formatterPath,
        outputPath: "/tmp/generated.ts",
        platform: "linux",
        repoRoot: "/repo",
      }),
    ).toEqual({
      command: formatterPath,
      args: ["--write", "/tmp/generated.ts"],
      shell: false,
    });
  });

  it("wraps pnpm.cmd explicitly on Windows instead of using shell mode", () => {
    expect(
      resolveGeneratedModuleFormatter({
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        existsSync: () => false,
        npmExecPath: "",
        outputPath: "C:\\Users\\test\\AppData\\Local\\Temp\\generated output.ts",
        platform: "win32",
        repoRoot: "C:\\repo",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        'pnpm.cmd exec oxfmt --write "C:\\Users\\test\\AppData\\Local\\Temp\\generated output.ts"',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });
});
