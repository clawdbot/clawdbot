import { describe, expect, it } from "vitest";
import { resolveSpawnCall, shouldUseCmdExeForCommand } from "../../scripts/ui.js";

describe("scripts/ui windows spawn behavior", () => {
  it("wraps Windows command launchers with cmd.exe without enabling shell mode", () => {
    expect(
      shouldUseCmdExeForCommand("C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.CMD", "win32"),
    ).toBe(true);

    expect(
      resolveSpawnCall(
        "C:\\Program Files\\nodejs\\pnpm.cmd",
        ["run", "build", "-t", "path with spaces"],
        { PATH: "C:\\bin" },
        { comSpec: "C:\\Windows\\System32\\cmd.exe", cwd: "C:\\repo\\ui", platform: "win32" },
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '"C:\\Program Files\\nodejs\\pnpm.cmd" run build -t "path with spaces"',
      ],
      options: {
        cwd: "C:\\repo\\ui",
        stdio: "inherit",
        env: { PATH: "C:\\bin" },
        shell: false,
        windowsVerbatimArguments: true,
      },
    });
  });

  it("does not use cmd.exe for non-command launchers", () => {
    expect(shouldUseCmdExeForCommand("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
    expect(shouldUseCmdExeForCommand("C:\\tools\\pnpm.com", "win32")).toBe(false);
    expect(shouldUseCmdExeForCommand("/usr/local/bin/pnpm", "linux")).toBe(false);

    expect(
      resolveSpawnCall(
        "C:\\Program Files\\nodejs\\pnpm.exe",
        ["run", "build"],
        { PATH: "C:\\bin" },
        { cwd: "C:\\repo\\ui", platform: "win32" },
      ),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\pnpm.exe",
      args: ["run", "build"],
      options: {
        cwd: "C:\\repo\\ui",
        stdio: "inherit",
        env: { PATH: "C:\\bin" },
        shell: false,
      },
    });
  });

  it("rejects unsafe cmd.exe arguments before launch", () => {
    expect(() =>
      resolveSpawnCall("C:\\tools\\pnpm.cmd", ["run", "build", "evil&calc"], undefined, {
        platform: "win32",
      }),
    ).toThrow(/unsafe windows cmd\.exe argument/i);
    expect(() =>
      resolveSpawnCall("C:\\tools\\pnpm.cmd", ["run", "build", "%PATH%"], undefined, {
        platform: "win32",
      }),
    ).toThrow(/unsafe windows cmd\.exe argument/i);
  });

  it("keeps non-Windows launches direct even with shell metacharacters", () => {
    expect(
      resolveSpawnCall(
        "/usr/local/bin/pnpm",
        ["run", "build", "contains&metacharacters"],
        { PATH: "/bin" },
        { cwd: "/repo/ui", platform: "linux" },
      ),
    ).toEqual({
      command: "/usr/local/bin/pnpm",
      args: ["run", "build", "contains&metacharacters"],
      options: {
        cwd: "/repo/ui",
        stdio: "inherit",
        env: { PATH: "/bin" },
        shell: false,
      },
    });
  });
});
