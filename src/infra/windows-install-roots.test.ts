import { afterEach, describe, expect, it } from "vitest";
import {
  _private,
  _resetWindowsInstallRootsForTests,
  getWindowsInstallRoots,
  getWindowsProgramFilesRoots,
  normalizeWindowsInstallRoot,
} from "./windows-install-roots.js";

afterEach(() => {
  _resetWindowsInstallRootsForTests();
});

describe("normalizeWindowsInstallRoot", () => {
  it("normalizes validated local Windows roots", () => {
    expect(normalizeWindowsInstallRoot(" D:/Apps/Program Files/ ")).toBe("D:\\Apps\\Program Files");
  });

  it("rejects invalid or overly broad values", () => {
    expect(normalizeWindowsInstallRoot("relative\\path")).toBeNull();
    expect(normalizeWindowsInstallRoot("\\\\server\\share\\Program Files")).toBeNull();
    expect(normalizeWindowsInstallRoot("D:\\")).toBeNull();
    expect(normalizeWindowsInstallRoot("D:\\Apps;E:\\Other")).toBeNull();
  });
});

describe("getWindowsInstallRoots", () => {
  it("prefers HKLM registry roots over process environment values", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: (key, valueName) => {
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" &&
          valueName === "SystemRoot"
        ) {
          return "D:\\Windows";
        }
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
          valueName === "ProgramFilesDir"
        ) {
          return "E:\\Programs";
        }
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
          valueName === "ProgramFilesDir (x86)"
        ) {
          return "F:\\Programs (x86)";
        }
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
          valueName === "ProgramW6432Dir"
        ) {
          return "E:\\Programs";
        }
        return null;
      },
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
  });

  it("uses explicit env roots without consulting HKLM", () => {
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: (key, valueName) => {
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" &&
          valueName === "SystemRoot"
        ) {
          return "D:\\Windows";
        }
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion" &&
          valueName === "ProgramFilesDir"
        ) {
          return "E:\\Programs";
        }
        return null;
      },
    });

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
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: () => null,
    });

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
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: () => "relative\\path",
    });

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
    _resetWindowsInstallRootsForTests({
      queryRegistryValue: () => null,
    });

    expect(
      getWindowsProgramFilesRoots({
        ProgramW6432: "D:\\Programs",
        ProgramFiles: "d:\\Programs\\",
        "ProgramFiles(x86)": "E:\\Programs (x86)",
      }),
    ).toEqual(["D:\\Programs", "E:\\Programs (x86)"]);
  });
});

describe("locateWindowsRegExe", () => {
  it("uses the fixed Windows system reg.exe candidate", () => {
    expect(_private.getWindowsRegExeCandidates()).toEqual(["C:\\Windows\\System32\\reg.exe"]);
  });

  it("does not resolve readable reg.exe files from env-derived roots", () => {
    _resetWindowsInstallRootsForTests({
      isReadableFile: (filePath) => filePath === "D:\\Windows\\System32\\reg.exe",
    });

    const originalEnv = process.env;
    try {
      process.env = {
        ...originalEnv,
        SystemRoot: "D:\\Windows",
        WINDIR: "E:\\Windows",
      };
      expect(_private.locateWindowsRegExe()).toBeNull();
    } finally {
      process.env = originalEnv;
    }
  });
});
