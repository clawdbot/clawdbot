import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw"));
const realMkdirSync = fs.mkdirSync.bind(fs);
const realMkdtempSync = fs.mkdtempSync.bind(fs);
const realRmSync = fs.rmSync.bind(fs);
const realWriteFileSync = fs.writeFileSync.bind(fs);
const realRealpathSyncNative = fs.realpathSync.native.bind(fs.realpathSync);

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

function mockTrashContainer(...suffixes: string[]) {
  let call = 0;
  return vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix) => {
    const suffix = suffixes[call] ?? "secure";
    call += 1;
    const container = `${prefix}${suffix}`;
    realMkdirSync(container, { recursive: true });
    return container;
  });
}

describe("browser trash", () => {
  let testRoot = "";
  let homeDir = "";
  let tmpDir = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    testRoot = realRealpathSyncNative(realMkdtempSync(path.join(os.tmpdir(), "openclaw-browser-")));
    homeDir = path.join(testRoot, "home", "test");
    tmpDir = path.join(testRoot, "tmp");
    realMkdirSync(path.join(homeDir, ".Trash"), { recursive: true, mode: 0o700 });
    realMkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    resolvePreferredOpenClawTmpDirMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(tmpDir);
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(os, "tmpdir").mockReturnValue(tmpDir);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) =>
      realRealpathSyncNative(candidate),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot) {
      realRmSync(testRoot, { recursive: true, force: true });
    }
  });

  function writeTrashTarget(name = "demo"): string {
    const target = path.join(tmpDir, name);
    realWriteFileSync(target, "demo");
    return target;
  }

  it("moves paths to a reserved user trash container without invoking a PATH-resolved command", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const mkdtempSync = mockTrashContainer("secure");
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");
    const target = writeTrashTarget();
    const expected = path.join(homeDir, ".Trash", "demo-123-secure", "demo");

    await expect(movePathToTrash(target)).resolves.toBe(expected);
    expect(mkdirSync).toHaveBeenCalledWith(path.join(homeDir, ".Trash"), {
      recursive: true,
      mode: 0o700,
    });
    expect(mkdtempSync).toHaveBeenCalledWith(path.join(homeDir, ".Trash", "demo-123-"));
    expect(renameSync).toHaveBeenCalledWith(target, expected);
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("uses the resolved trash directory for reserved destinations", async () => {
    const { movePathToTrash } = await import("./trash.js");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const resolvedHomeDir = path.join(testRoot, "real", "home", "test");
    const resolvedTrashDir = path.join(resolvedHomeDir, ".Trash");
    realMkdirSync(resolvedTrashDir, { recursive: true, mode: 0o700 });
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => {
      const value = String(candidate);
      if (value === homeDir) {
        return resolvedHomeDir;
      }
      if (value === path.join(homeDir, ".Trash")) {
        return resolvedTrashDir;
      }
      return realRealpathSyncNative(candidate);
    });
    const mkdtempSync = mockTrashContainer("secure");
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const target = writeTrashTarget();
    const expected = path.join(resolvedTrashDir, "demo-123-secure", "demo");

    await expect(movePathToTrash(target)).resolves.toBe(expected);
    expect(mkdtempSync).toHaveBeenCalledWith(path.join(resolvedTrashDir, "demo-123-"));
    expect(renameSync).toHaveBeenCalledWith(target, expected);
  });

  it("refuses to trash filesystem roots", async () => {
    const { movePathToTrash } = await import("./trash.js");

    await expect(movePathToTrash("/")).rejects.toThrow("Refusing to trash root path");
  });

  it("refuses to trash paths outside allowed roots", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const outsideDir = path.join(testRoot, "outside");
    realMkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, "openclaw-demo");
    realWriteFileSync(outsidePath, "outside");

    await expect(movePathToTrash(outsidePath)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("refuses to use a symlinked trash directory", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const realTrashDir = path.join(testRoot, "real-trash");
    realRmSync(path.join(homeDir, ".Trash"), { recursive: true, force: true });
    realMkdirSync(realTrashDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(realTrashDir, path.join(homeDir, ".Trash"), "dir");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);

    await expect(movePathToTrash(writeTrashTarget())).rejects.toThrow(
      "Refusing to use non-directory/symlink trash directory",
    );
  });

  it("falls back to copy and remove when rename crosses filesystems", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    mockTrashContainer("secure");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw exdev;
    });
    const cpSync = vi.spyOn(fs, "cpSync").mockImplementation(() => undefined);
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
    const target = writeTrashTarget();
    const expected = path.join(homeDir, ".Trash", "demo-123-secure", "demo");

    await expect(movePathToTrash(target)).resolves.toBe(expected);
    expect(cpSync).toHaveBeenCalledWith(target, expected, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledWith(target, { recursive: true, force: false });
  });

  it("retries copy fallback when the copy destination is created concurrently", async () => {
    const { movePathToTrash } = await import("./trash.js");
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
    const target = writeTrashTarget();
    const first = path.join(homeDir, ".Trash", "demo-123-first", "demo");
    const second = path.join(homeDir, ".Trash", "demo-123-second", "demo");

    await expect(movePathToTrash(target)).resolves.toBe(second);
    expect(cpSync).toHaveBeenNthCalledWith(1, target, first, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(cpSync).toHaveBeenNthCalledWith(2, target, second, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledTimes(1);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it("retries with the same timestamp when the destination is created concurrently", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    mockTrashContainer("first", "second");
    const renameSync = vi
      .spyOn(fs, "renameSync")
      .mockImplementationOnce(() => {
        throw collision;
      })
      .mockImplementation(() => undefined);
    const target = writeTrashTarget();
    const first = path.join(homeDir, ".Trash", "demo-123-first", "demo");
    const second = path.join(homeDir, ".Trash", "demo-123-second", "demo");

    await expect(movePathToTrash(target)).resolves.toBe(second);
    expect(renameSync).toHaveBeenNthCalledWith(1, target, first);
    expect(renameSync).toHaveBeenNthCalledWith(2, target, second);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });
});
