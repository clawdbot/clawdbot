import { afterEach, describe, expect, it, vi } from "vitest";

describe("handleLogbookSnapshot platform routing", () => {
  afterEach(() => {
    vi.doUnmock("./node-host-windows.runtime.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("routes Windows captures through the lazy runtime", async () => {
    const captureWindowsLogbookSnapshot = vi.fn(async () => ({
      format: "jpeg" as const,
      base64: "d2luZG93cw==",
      width: 1440,
      height: 900,
    }));
    vi.doMock("./node-host-windows.runtime.js", () => ({ captureWindowsLogbookSnapshot }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { handleLogbookSnapshot } = await import("./node-host.js");
    const params = { screenIndex: 1, maxWidth: 1440, quality: 0.6 };

    await expect(handleLogbookSnapshot(params)).resolves.toMatchObject({
      format: "jpeg",
      width: 1440,
      height: 900,
    });
    expect(captureWindowsLogbookSnapshot).toHaveBeenCalledWith(params);
  });

  it("returns an actionable error when the Windows runtime cannot load", async () => {
    vi.doMock("./node-host-windows.runtime.js", () => {
      throw new Error("Cannot find native binding");
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { handleLogbookSnapshot } = await import("./node-host.js");

    await expect(handleLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(
        /could not load node-screenshots or Rastermill:.*Reinstall OpenClaw/,
      ),
    });
  });

  it("does not mislabel an unexpected Windows runtime failure as a load failure", async () => {
    vi.doMock("./node-host-windows.runtime.js", () => ({
      captureWindowsLogbookSnapshot: () => {
        throw new Error("unexpected native state");
      },
    }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { handleLogbookSnapshot } = await import("./node-host.js");

    await expect(handleLogbookSnapshot({})).resolves.toEqual({
      error: expect.stringMatching(
        /capture failed unexpectedly: unexpected native state.*inspect the node-host logs/,
      ),
    });
  });

  it("does not load the Windows runtime on unsupported platforms", async () => {
    const loadWindowsRuntime = vi.fn(() => {
      throw new Error("Windows runtime must stay lazy");
    });
    vi.doMock("./node-host-windows.runtime.js", loadWindowsRuntime);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { handleLogbookSnapshot } = await import("./node-host.js");

    await expect(handleLogbookSnapshot({})).resolves.toEqual({
      error: "logbook.snapshot is not supported on linux",
    });
    expect(loadWindowsRuntime).not.toHaveBeenCalled();
  });
});
