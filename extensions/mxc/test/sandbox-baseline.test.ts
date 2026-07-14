import { describe, expect, test } from "vitest";
import {
  DEFAULT_SANDBOX_BASELINE,
  resolveBaselineReadonlyPaths,
  resolveSandboxBaseline,
  resolveSandboxTempDir,
} from "../src/sandbox-baseline.js";

describe("resolveSandboxBaseline", () => {
  test("returns enforceable defaults", () => {
    expect(resolveSandboxBaseline()).toEqual(DEFAULT_SANDBOX_BASELINE);
    expect(resolveSandboxBaseline().filesystem.restrictToProjectDir).toBe(true);
    expect(resolveSandboxBaseline().process.timeoutSeconds).toBe(300);
    expect(resolveSandboxBaseline().process.timeoutSecondsConfigured).toBe(false);
  });

  test("merges partial input with defaults", () => {
    const baseline = resolveSandboxBaseline({
      filesystem: {
        restrictToProjectDir: false,
        additionalReadonlyPaths: ["C:\\tools\\readonly"],
        additionalReadwritePaths: ["C:\\work\\scratch"],
      },
      process: {
        timeoutSeconds: 45,
      },
    });

    expect(baseline.filesystem.restrictToProjectDir).toBe(false);
    expect(baseline.filesystem.additionalReadonlyPaths).toEqual(["C:\\tools\\readonly"]);
    expect(baseline.filesystem.additionalReadwritePaths).toEqual(["C:\\work\\scratch"]);
    expect(baseline.process.timeoutSeconds).toBe(45);
    expect(baseline.process.timeoutSecondsConfigured).toBe(true);
  });

  test("rejects invalid timeout values", () => {
    expect(() => resolveSandboxBaseline({ process: { timeoutSeconds: 0 } })).toThrow(
      /timeoutSeconds/u,
    );
    expect(() => resolveSandboxBaseline({ process: { timeoutSeconds: Number.NaN } })).toThrow(
      /timeoutSeconds/u,
    );
  });
});

describe("effective filesystem policy", () => {
  test("derives baseline readonly directories from the host Windows env", () => {
    const paths = resolveBaselineReadonlyPaths({
      SystemRoot: "D:\\Windows",
      ProgramFiles: "D:\\Program Files",
      "ProgramFiles(x86)": "D:\\Program Files (x86)",
    });

    expect(paths).toEqual([
      "D:\\Program Files",
      "D:\\Program Files (x86)",
      "D:\\Windows\\System32",
      "D:\\Windows\\SysWOW64",
    ]);
  });

  test("uses deterministic fallback readonly directories when env values are absent", () => {
    expect(resolveBaselineReadonlyPaths({})).toEqual([
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\Windows\\System32",
      "C:\\Windows\\SysWOW64",
    ]);
  });

  test("prefers the configured Windows temp directory", () => {
    expect(resolveSandboxTempDir({ TEMP: "C:\\Temp" })).toBe("C:\\Temp");
  });

  test("uses Windows temp when TEMP and TMP are absent", () => {
    expect(resolveSandboxTempDir({})).toBe("C:\\Windows\\Temp");
  });
});
