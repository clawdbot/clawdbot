import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeTrackedBrowserTabsForSessionsImpl = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const runExec = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../process/exec.js", () => ({
  runExec,
}));

function mockTrashContainer(...suffixes: string[]) {
  let call = 0;
  return vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix) => {
    const suffix = suffixes[call] ?? "secure";
    call += 1;
    return `${prefix}${suffix}`;
  });
}

describe("browser maintenance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    closeTrackedBrowserTabsForSessionsImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    runExec.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
    vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
    vi.spyOn(fs, "lstatSync").mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => String(candidate));
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl,
    });
  });

  it("skips browser cleanup when no session keys are provided", async () => {
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("delegates cleanup through the browser maintenance surface", async () => {
    closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);

    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"] }),
    ).resolves.toBe(2);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });
    expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledWith({
      sessionKeys: ["agent:main:test"],
    });
  });

  it("moves paths to a reserved user trash container without invoking a PATH-resolved command", async () => {
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const mkdtempSync = mockTrashContainer("secure");
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe(
      "/home/test/.Trash/demo-123-secure/demo",
    );
    expect(runExec).not.toHaveBeenCalled();
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", {
      recursive: true,
      mode: 0o700,
    });
    expect(mkdtempSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123-");
    expect(renameSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123-secure/demo");
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("uses the resolved trash directory for reserved destinations", async () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === "/home/test") {
        return "/real/home/test";
      }
      if (value === "/home/test/.Trash") {
        return "/real/home/test/.Trash";
      }
      return value;
    });
    const mkdtempSync = mockTrashContainer("secure");
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe(
      "/real/home/test/.Trash/demo-123-secure/demo",
    );
    expect(mkdtempSync).toHaveBeenCalledWith("/real/home/test/.Trash/demo-123-");
    expect(renameSync).toHaveBeenCalledWith(
      "/tmp/demo",
      "/real/home/test/.Trash/demo-123-secure/demo",
    );
  });

  it("refuses to trash filesystem roots", async () => {
    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/")).rejects.toThrow("Refusing to trash root path");
  });

  it("refuses to trash paths outside allowed roots", async () => {
    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/etc/openclaw-demo")).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("refuses to use a symlinked trash directory", async () => {
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "lstatSync").mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => true,
    } as fs.Stats);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).rejects.toThrow(
      "Refusing to use non-directory/symlink trash directory",
    );
  });

  it("falls back to copy and remove when rename crosses filesystems", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    mockTrashContainer("secure");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi.spyOn(fs, "cpSync").mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe(
      "/home/test/.Trash/demo-123-secure/demo",
    );
    expect(cpSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123-secure/demo", {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledWith("/tmp/demo", { recursive: true, force: false });
  });

  it("retries copy fallback when the copy destination is created concurrently", async () => {
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const copyCollision = Object.assign(new Error("copy exists"), {
      code: "ERR_FS_CP_EEXIST",
    });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    mockTrashContainer("first", "second");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi
      .spyOn(fs, "cpSync")
      .mockImplementationOnce(() => {
        throw copyCollision;
      })
      .mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe(
      "/home/test/.Trash/demo-123-second/demo",
    );
    expect(cpSync).toHaveBeenNthCalledWith(
      1,
      "/tmp/demo",
      "/home/test/.Trash/demo-123-first/demo",
      {
        recursive: true,
        force: false,
        errorOnExist: true,
      },
    );
    expect(cpSync).toHaveBeenNthCalledWith(
      2,
      "/tmp/demo",
      "/home/test/.Trash/demo-123-second/demo",
      {
        recursive: true,
        force: false,
        errorOnExist: true,
      },
    );
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("retries with the same timestamp when the destination is created concurrently", async () => {
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    mockTrashContainer("first", "second");
    const renameSync = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw collision;
      })
      .mockImplementation(() => undefined);

    const { movePathToTrash } = await import("./browser-maintenance.js");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe(
      "/home/test/.Trash/demo-123-second/demo",
    );
    expect(renameSync).toHaveBeenNthCalledWith(
      1,
      "/tmp/demo",
      "/home/test/.Trash/demo-123-first/demo",
    );
    expect(renameSync).toHaveBeenNthCalledWith(
      2,
      "/tmp/demo",
      "/home/test/.Trash/demo-123-second/demo",
    );
    expect(Date.now).toHaveBeenCalledTimes(1);
  });
});
