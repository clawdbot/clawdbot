import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserOpenCommand } from "./browser-open.js";
import { _resetWindowsInstallRootsForTests } from "./windows-install-roots.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetWindowsInstallRootsForTests();
});

describe("resolveBrowserOpenCommand", () => {
  it("does not resolve Windows browser launching through a relative SystemRoot", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", ".\\fake-root");
    vi.stubEnv("windir", ".\\fake-windir");
    _resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });

    const resolved = await resolveBrowserOpenCommand();

    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");
    expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
    expect(resolved.command).toBe(rundll32);
  });

  it("prefers the registry-backed Windows system root over process env", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");
    _resetWindowsInstallRootsForTests({
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
});
