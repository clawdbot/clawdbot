// Covers platform browser-open command resolution.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { detectBinaryMock, getWindowsInstallRootsMock } = vi.hoisted(() => ({
  detectBinaryMock: vi.fn(async () => false),
  getWindowsInstallRootsMock: vi.fn(() => ({ systemRoot: "C:\\Windows" })),
}));

vi.mock("./detect-binary.js", () => ({
  detectBinary: detectBinaryMock,
}));

vi.mock("./windows-install-roots.js", async () => {
  const actual = await vi.importActual<typeof import("./windows-install-roots.js")>(
    "./windows-install-roots.js",
  );
  return { ...actual, getWindowsInstallRoots: getWindowsInstallRootsMock };
});

import { resolveBrowserOpenCommand } from "./browser-open.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  detectBinaryMock.mockReset().mockResolvedValue(false);
  getWindowsInstallRootsMock.mockReset().mockReturnValue({ systemRoot: "C:\\Windows" });
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
