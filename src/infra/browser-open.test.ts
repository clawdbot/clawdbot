// Covers platform browser-open command resolution.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec-result.js";

const { detectBinaryMock, getWindowsInstallRootsMock, runCommandWithTimeoutMock } = vi.hoisted(
  () => ({
    detectBinaryMock: vi.fn(async () => false),
    getWindowsInstallRootsMock: vi.fn(() => ({ systemRoot: "C:\\Windows" })),
    runCommandWithTimeoutMock: vi.fn<() => Promise<SpawnResult>>(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    })),
  }),
);

vi.mock("./detect-binary.js", () => ({
  detectBinary: detectBinaryMock,
}));

vi.mock("./windows-install-roots.js", async () => {
  const actual = await vi.importActual<typeof import("./windows-install-roots.js")>(
    "./windows-install-roots.js",
  );
  return { ...actual, getWindowsInstallRoots: getWindowsInstallRootsMock };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: runCommandWithTimeoutMock,
}));

import { openUrl, resolveBrowserOpenCommand } from "./browser-open.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  detectBinaryMock.mockReset().mockResolvedValue(false);
  getWindowsInstallRootsMock.mockReset().mockReturnValue({ systemRoot: "C:\\Windows" });
  runCommandWithTimeoutMock.mockReset().mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
});

describe("openUrl", () => {
  it("returns true after a normal zero exit", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    await expect(openUrl("https://example.com/")).resolves.toBe(true);
  });

  it("returns false after a non-zero exit", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "browser opener failed",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(openUrl("https://example.com/")).resolves.toBe(false);
  });

  it("returns false after a timeout", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 124,
      signal: null,
      killed: true,
      termination: "timeout",
    });

    await expect(openUrl("https://example.com/")).resolves.toBe(false);
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("does not resolve Windows browser launching through a relative SystemRoot", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", ".\\fake-root");
    vi.stubEnv("windir", ".\\fake-windir");

    const resolved = await resolveBrowserOpenCommand();

    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("prefers the registry-backed Windows system root over process env", async () => {
    getWindowsInstallRootsMock.mockReturnValue({ systemRoot: "D:\\Windows" });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");

    const resolved = await resolveBrowserOpenCommand();

    const rundll32 = path.win32.join("D:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("resolves macOS open even when SSH environment variables are present", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");
    detectBinaryMock.mockResolvedValueOnce(true);

    const resolved = await resolveBrowserOpenCommand();

    expect(detectBinaryMock).toHaveBeenCalledWith("open");
    expect(resolved).toEqual({ argv: ["open"], command: "open" });
  });

  it("still refuses browser launch over Linux SSH without a display", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("SSH_CONNECTION", "192.0.2.1 12345 192.0.2.2 22");

    const resolved = await resolveBrowserOpenCommand();

    expect(resolved).toEqual({ argv: null, reason: "ssh-no-display" });
  });
});
