import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const detectBinaryMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./detect-binary.js", () => ({
  detectBinary: detectBinaryMock,
}));

import { resolveBrowserOpenCommand } from "./browser-open.js";
import { resetWindowsInstallRootsForTests } from "./windows-install-roots.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  detectBinaryMock.mockReset().mockResolvedValue(false);
  resetWindowsInstallRootsForTests();
});

describe("resolveBrowserOpenCommand", () => {
  it("does not resolve Windows browser launching through a relative SystemRoot", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", ".\\fake-root");
    vi.stubEnv("windir", ".\\fake-windir");
    resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });

    const resolved = await resolveBrowserOpenCommand();

    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("prefers the registry-backed Windows system root over process env", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");
    resetWindowsInstallRootsForTests({
      queryRegistryValue: (key, valueName) => {
        if (
          key === "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" &&
          valueName === "SystemRoot"
        ) {
          return "D:\\Windows";
        }
        return null;
      },
    });

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
