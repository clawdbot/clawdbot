// Tests for Windows shell command analysis and platform detection.
import { describe, expect, it } from "vitest";
import { analyzeWindowsShellCommand, isWindowsPlatform } from "./windows-shell-command.js";

describe("isWindowsPlatform", () => {
  it("defaults to process.platform when called without arguments", () => {
    expect(isWindowsPlatform()).toBe(process.platform.startsWith("win"));
  });

  it("defaults to process.platform when passed undefined", () => {
    expect(isWindowsPlatform(undefined)).toBe(process.platform.startsWith("win"));
  });

  it("defaults to process.platform when passed null", () => {
    expect(isWindowsPlatform(null)).toBe(process.platform.startsWith("win"));
  });

  it("respects explicit platform overrides", () => {
    expect(isWindowsPlatform("win32")).toBe(true);
    expect(isWindowsPlatform("linux")).toBe(false);
    expect(isWindowsPlatform("darwin")).toBe(false);
    expect(isWindowsPlatform("freebsd")).toBe(false);
  });

  it("returns true on Windows hosts when no override is provided", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(isWindowsPlatform()).toBe(true);
      expect(isWindowsPlatform(undefined)).toBe(true);
      expect(isWindowsPlatform(null)).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("returns false on non-Windows hosts when no override is provided", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      expect(isWindowsPlatform()).toBe(false);
      expect(isWindowsPlatform(undefined)).toBe(false);
      expect(isWindowsPlatform(null)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});

describe("analyzeWindowsShellCommand", () => {
  it("defaults to process.platform when platform is omitted", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const result = analyzeWindowsShellCommand({ command: "Get-Process" });
      expect(result.ok).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
