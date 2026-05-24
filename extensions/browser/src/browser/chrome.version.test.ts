import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

import { readBrowserVersion } from "./chrome.executables.js";

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("readBrowserVersion", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    stubPlatform(originalPlatform);
    execFileSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it("reads macOS app bundle versions from Info.plist before spawning Chrome", () => {
    stubPlatform("darwin");
    execFileSyncMock.mockReturnValue("148.0.7778.179\n");

    const version = readBrowserVersion(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );

    expect(version).toBe("148.0.7778.179");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleShortVersionString",
        "/Applications/Google Chrome.app/Contents/Info.plist",
      ],
      expect.objectContaining({ timeout: 800 }),
    );
  });

  it("falls back to a slower --version probe when macOS bundle metadata is unavailable", () => {
    stubPlatform("darwin");
    execFileSyncMock
      .mockImplementationOnce(() => {
        throw new Error("plist unavailable");
      })
      .mockReturnValueOnce("Google Chrome 148.0.7778.179\n");

    const version = readBrowserVersion(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );

    expect(version).toBe("Google Chrome 148.0.7778.179");
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--version"],
      expect.objectContaining({ timeout: 6000 }),
    );
  });

  it("uses the slower --version probe for non-bundle paths", () => {
    stubPlatform("darwin");
    execFileSyncMock.mockReturnValue("Chromium 148.0.7778.179\n");

    const version = readBrowserVersion("/opt/chromium/chrome");

    expect(version).toBe("Chromium 148.0.7778.179");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "/opt/chromium/chrome",
      ["--version"],
      expect.objectContaining({ timeout: 6000 }),
    );
  });
});
