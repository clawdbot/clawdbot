// Qa Lab tests cover Windows system tool path resolution.
import { describe, expect, it, vi } from "vitest";
import {
  resolveQaWindowsPowerShellExePath,
  resolveQaWindowsSystem32ExePath,
  runQaWindowsTaskkill,
} from "./windows-system-tools.js";

describe("qa-lab windows system tools", () => {
  it("resolves System32 executables from a trusted SystemRoot", () => {
    expect(resolveQaWindowsSystem32ExePath("taskkill.exe", { SystemRoot: "D:\\Windows\\" })).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveQaWindowsPowerShellExePath({ SystemRoot: "D:\\Windows\\" })).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("force-kills a process tree when graceful taskkill fails", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });

    expect(
      runQaWindowsTaskkill({
        pid: 12345,
        signal: "SIGTERM",
        env: { SystemRoot: "D:\\Windows" },
        runCommand,
      }),
    ).toBe(true);
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "D:\\Windows\\System32\\taskkill.exe",
      ["/PID", "12345", "/T"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "D:\\Windows\\System32\\taskkill.exe",
      ["/PID", "12345", "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
  });

  it("falls back to the default Windows root when env roots are unsafe", () => {
    expect(resolveQaWindowsSystem32ExePath("taskkill.exe", { SystemRoot: "C:\\tmp;C:\\bad" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("rejects non-basename System32 executable names", () => {
    expect(() => resolveQaWindowsSystem32ExePath("..\\taskkill.exe")).toThrow(
      "Invalid Windows System32 executable name",
    );
    expect(() => resolveQaWindowsSystem32ExePath("taskkill")).toThrow(
      "Invalid Windows System32 executable name",
    );
  });
});
