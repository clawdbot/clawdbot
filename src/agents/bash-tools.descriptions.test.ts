/**
 * Tests for the model-facing exec/process tool descriptions.
 * Protects the Windows PowerShell command-language guidance contract
 * produced by describeExecTool (issue #117644).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";

const initialProcessPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function restoreProcessPlatformForTest(): void {
  if (initialProcessPlatform) {
    Object.defineProperty(process, "platform", initialProcessPlatform);
  }
}

describe("describeExecTool", () => {
  beforeEach(() => restoreProcessPlatformForTest());
  afterEach(() => restoreProcessPlatformForTest());

  it("returns the base description without Windows guidance on non-win32 platforms", () => {
    setProcessPlatformForTest("linux");
    const description = describeExecTool();
    expect(description).toBe(
      "Run shell now; background continuation supported. Use yieldMs/background, then process for logs/status/input/intervention. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. TTY CLI/UI/coding agent: pty=true.",
    );
    expect(description).not.toContain("PowerShell");
    expect(description).not.toContain("Select-Object");
  });

  it("emits PowerShell command-language guidance on win32", () => {
    setProcessPlatformForTest("win32");
    const description = describeExecTool();

    // Preserves the direct-executable instruction (issue #117644 root cause:
    // extend, not replace, the existing Windows guidance).
    expect(description).toContain("Run executables directly");
    expect(description).toContain("do NOT wrap commands in `cmd /c`");

    // PowerShell pipeline: Select-Object -First N instead of head -N.
    expect(description).toContain("Select-Object -First N");
    expect(description).toContain("head -N");

    // Home path: $env:USERPROFILE instead of ~.
    expect(description).toContain("$env:USERPROFILE");
    expect(description).toContain("instead of `~`");

    // Redirect: 2>$null instead of 2>nul.
    expect(description).toContain("2>$null");
    expect(description).toContain("2>nul");

    // Avoid Unix-only utilities.
    expect(description).toMatch(/avoid unix-only utilities/i);
    expect(description).toContain("sed, awk, grep, head, tail");
  });

  it("produces stable output across repeated calls on win32", () => {
    setProcessPlatformForTest("win32");
    const first = describeExecTool();
    const second = describeExecTool();
    expect(second).toEqual(first);
  });
});

describe("describeProcessTool", () => {
  beforeEach(() => restoreProcessPlatformForTest());
  afterEach(() => restoreProcessPlatformForTest());

  it("returns the process-control description on any platform", () => {
    setProcessPlatformForTest("win32");
    const description = describeProcessTool();
    expect(description).toContain("Control existing exec");
  });
});
