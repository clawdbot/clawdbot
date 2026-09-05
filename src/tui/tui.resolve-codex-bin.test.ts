// Covers bounded TUI Codex CLI lookup command selection.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform, withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: runCommandWithTimeoutMock }));

import { resolveCodexCliBin, resolveLocalAuthSpawnInvocation } from "./tui.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runCommandWithTimeoutMock.mockReset();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
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

    await withMockedPlatform("linux", async () => {
      await expect(resolveCodexCliBin()).resolves.toBeNull();
    });
  });

  it("selects the Windows npm command shim from a Unicode PATH entry", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tui-codex-"));
    tempDirs.push(tempDir);
    const binDir = path.join(tempDir, "Codex Å tools");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\n");
    const commandPath = path.join(binDir, "codex.cmd");
    fs.writeFileSync(commandPath, "@echo off\r\n");
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("PATHEXT", ".CMD;.EXE");

    await withMockedWindowsPlatform(async () => {
      await expect(resolveCodexCliBin()).resolves.toBe(commandPath);
      expect(
        resolveLocalAuthSpawnInvocation({
          command: commandPath,
          args: ["login"],
          platform: "win32",
        }),
      ).toMatchObject({
        args: ["/d", "/s", "/c", expect.stringContaining("codex.cmd")],
        options: { windowsHide: true, windowsVerbatimArguments: true },
      });
    });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("keeps native Windows executables and reports a missing Codex CLI", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tui-codex-native-"));
    tempDirs.push(tempDir);
    const executablePath = path.join(tempDir, "codex.exe");
    fs.copyFileSync(process.execPath, executablePath);
    vi.stubEnv("PATH", tempDir);
    vi.stubEnv("PATHEXT", ".EXE");

    await withMockedWindowsPlatform(async () => {
      await expect(resolveCodexCliBin()).resolves.toBe(executablePath);
      vi.stubEnv("PATH", path.join(tempDir, "missing"));
      await expect(resolveCodexCliBin()).resolves.toBeNull();
    });
  });

  it("falls back to a bare-only native Windows Codex executable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tui-codex-bare-"));
    tempDirs.push(tempDir);
    const executablePath = path.join(tempDir, "codex");
    fs.copyFileSync(process.execPath, executablePath);
    vi.stubEnv("PATH", tempDir);
    vi.stubEnv("PATHEXT", ".CMD;.EXE");

    await withMockedWindowsPlatform(async () => {
      await expect(resolveCodexCliBin()).resolves.toBe(executablePath);
    });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });
});
