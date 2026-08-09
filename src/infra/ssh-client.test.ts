import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSystemBin } from "./resolve-system-bin.js";
import { getWindowsInstallRoots } from "./windows-install-roots.js";

vi.mock("./resolve-system-bin.js", () => ({
  resolveSystemBin: vi.fn(),
}));

vi.mock("./windows-install-roots.js", () => ({
  getWindowsInstallRoots: vi.fn(),
}));

import { resolveSshClient } from "./ssh-client.js";

const resolveSystemBinMock = vi.mocked(resolveSystemBin);
const getWindowsInstallRootsMock = vi.mocked(getWindowsInstallRoots);

describe("resolveSshClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resolveSystemBinMock.mockReset();
    getWindowsInstallRootsMock.mockReset();
  });

  it("uses the shared strict resolver on Unix", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    resolveSystemBinMock.mockReturnValue("/usr/bin/ssh");

    expect(resolveSshClient()).toBe("/usr/bin/ssh");
    expect(resolveSystemBinMock).toHaveBeenCalledWith("ssh", { trust: "strict" });
    expect(getWindowsInstallRootsMock).not.toHaveBeenCalled();
  });

  it("adds only the Windows-managed OpenSSH directory", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    getWindowsInstallRootsMock.mockReturnValue({
      systemRoot: "D:\\Windows",
      programFiles: "D:\\Program Files",
      programFilesX86: "D:\\Program Files (x86)",
      programW6432: null,
    });
    const sshPath = path.win32.join("D:\\Windows", "System32", "OpenSSH", "ssh.exe");
    resolveSystemBinMock.mockReturnValue(sshPath);

    expect(resolveSshClient()).toBe(sshPath);
    expect(resolveSystemBinMock).toHaveBeenCalledWith("ssh", {
      trust: "strict",
      extraDirs: [path.win32.join("D:\\Windows", "System32", "OpenSSH")],
    });
  });
});
