// Covers bounded TUI Codex CLI lookup command selection.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform, withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommandWithTimeoutMock }));

import { resolveCodexCliBin } from "./tui.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runCommandWithTimeoutMock.mockReset();
});

describe("resolveCodexCliBin", () => {
  it("bounds lookup and returns the first PATH match", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "/usr/local/bin/codex\n/opt/bin/codex\n",
      termination: "exit",
    });

    await withMockedPlatform("linux", async () => {
      await expect(resolveCodexCliBin()).resolves.toBe("/usr/local/bin/codex");
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["which", "codex"], {
      killSignal: "SIGKILL",
      maxOutputBytes: 64 * 1024,
      timeoutMs: 5_000,
    });
  });

  it("returns null when lookup times out", async () => {
    runCommandWithTimeoutMock.mockResolvedValue({
      code: null,
      stdout: "",
      termination: "timeout",
    });

    await expect(resolveCodexCliBin()).resolves.toBeNull();
  });

  it("uses the trusted Windows where.exe", async () => {
    const accessSync = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((filePath, mode) => {
      if (String(filePath).toLowerCase() === "c:\\windows\\system32\\reg.exe") {
        throw new Error("registry lookup disabled for test");
      }
      return accessSync(filePath, mode);
    });
    vi.stubEnv("SystemRoot", "D:\\Windows");
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "D:\\Tools\\codex.exe\r\n",
      termination: "exit",
    });

    await withMockedWindowsPlatform(async () => {
      await expect(resolveCodexCliBin()).resolves.toBe("D:\\Tools\\codex.exe");
    });
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      [path.win32.join("D:\\Windows", "System32", "where.exe"), "codex"],
      {
        killSignal: "SIGKILL",
        maxOutputBytes: 64 * 1024,
        timeoutMs: 5_000,
      },
    );
  });
});
