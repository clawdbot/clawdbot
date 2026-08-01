// Covers Windows install-root normalization and discovery.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFileSync: execFileSyncMock };
});
import {
  getWindowsCmdExePath,
  getWindowsInstallRoots,
  getWindowsPowerShellExePath,
  getWindowsProgramFilesRoots,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
});

describe("getWindowsInstallRoots", () => {
  it("prefers HKLM registry roots over process environment values", () => {
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    execFileSyncMock.mockImplementation((_file, args: string[]) => {
      const valueName = args[3];
      const values: Record<string, string> = {
        SystemRoot: "D:\\Windows",
        ProgramFilesDir: "E:\\Programs",
        "ProgramFilesDir (x86)": "F:\\Programs (x86)",
        ProgramW6432Dir: "E:\\Programs",
      };
      const value = valueName ? values[valueName] : undefined;
      return value ? `${valueName}    REG_SZ    ${value}\r\n` : "";
    });
    const originalEnv = process.env;
    let roots;
    try {
      process.env = {
        ...originalEnv,
        SystemRoot: "C:\\PoisonedWindows",
        ProgramFiles: "C:\\Poisoned Programs",
        "ProgramFiles(x86)": "C:\\Poisoned Programs (x86)",
        ProgramW6432: "C:\\Poisoned Programs",
      };
      roots = getWindowsInstallRoots();
    } finally {
      process.env = originalEnv;
    }

    expect(roots).toEqual({
      systemRoot: "D:\\Windows",
      programFiles: "E:\\Programs",
      programFilesX86: "F:\\Programs (x86)",
      programW6432: "E:\\Programs",
    });
    expect(execFileSyncMock).toHaveBeenCalled();
    for (const [file] of execFileSyncMock.mock.calls) {
      expect(file).toBe("C:\\Windows\\System32\\reg.exe");
    }
  });

  it("uses explicit env roots without consulting HKLM", () => {
    const roots = getWindowsInstallRoots({
      SystemRoot: "G:\\Windows",
      ProgramFiles: "H:\\Programs",
      "ProgramFiles(x86)": "I:\\Programs (x86)",
      ProgramW6432: "H:\\Programs",
    });

    expect(roots).toEqual({
      systemRoot: "G:\\Windows",
      programFiles: "H:\\Programs",
      programFilesX86: "I:\\Programs (x86)",
      programW6432: "H:\\Programs",
    });
  });

  it("falls back to validated env roots when registry lookup is unavailable", () => {
    const roots = getWindowsInstallRoots({
      systemroot: "D:\\Windows\\",
      programfiles: "E:\\Programs",
      "PROGRAMFILES(X86)": "F:\\Programs (x86)\\",
      programw6432: "E:\\Programs",
    });

    expect(roots).toEqual({
      systemRoot: "D:\\Windows",
      programFiles: "E:\\Programs",
      programFilesX86: "F:\\Programs (x86)",
      programW6432: "E:\\Programs",
    });
  });

  it("falls back to defaults when registry and env roots are invalid", () => {
    const roots = getWindowsInstallRoots({
      SystemRoot: "relative\\Windows",
      ProgramFiles: "\\\\server\\share\\Program Files",
      "ProgramFiles(x86)": "D:\\",
      ProgramW6432: "C:\\Programs;D:\\Other",
    });

    expect(roots).toEqual({
      systemRoot: "C:\\Windows",
      programFiles: "C:\\Program Files",
      programFilesX86: "C:\\Program Files (x86)",
      programW6432: null,
    });
  });
});

describe("getWindowsProgramFilesRoots", () => {
  it("prefers ProgramW6432 and dedupes roots case-insensitively", () => {
    expect(
      getWindowsProgramFilesRoots({
        ProgramW6432: "D:\\Programs",
        ProgramFiles: "d:\\Programs\\",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
      }),
    ).toEqual(["D:\\Programs", "E:\\Programs (x86)"]);
  });
});

describe("Windows system executable helpers", () => {
  it("resolves cmd.exe from the trusted Windows system root", () => {
    expect(getWindowsCmdExePath({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
  });

  it("resolves trusted Windows process-inspection tools", () => {
    const env = { SystemRoot: "D:\\Windows" };

    expect(getWindowsSystem32ExePath("netstat.exe", env)).toBe(
      "D:\\Windows\\System32\\netstat.exe",
    );
    expect(getWindowsPowerShellExePath(env)).toBe(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(getWindowsWmicExePath(env)).toBe("D:\\Windows\\System32\\wbem\\wmic.exe");
  });

  it("rejects unsafe System32 executable names", () => {
    expect(() => getWindowsSystem32ExePath("..\\netstat.exe")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
    expect(() => getWindowsSystem32ExePath("netstat")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
  });
});
