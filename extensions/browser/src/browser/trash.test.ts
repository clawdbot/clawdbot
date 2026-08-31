// Browser tests cover trash plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browserUtilsMock = vi.hoisted(() => ({ configDir: "/tmp/openclaw-state" }));
const realMkdirSync = fs.mkdirSync.bind(fs);
const realMkdtempSync = fs.mkdtempSync.bind(fs);
const realRmSync = fs.rmSync.bind(fs);
const realWriteFileSync = fs.writeFileSync.bind(fs);
const realRealpathSyncNative = fs.realpathSync.native.bind(fs.realpathSync);

vi.mock("../utils.js", () => ({
  get CONFIG_DIR() {
    return browserUtilsMock.configDir;
  },
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
  let configDir = "";
  let homeDir = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    testRoot = realRealpathSyncNative(realMkdtempSync(path.join(os.tmpdir(), "openclaw-browser-")));
    configDir = path.join(testRoot, "state");
    homeDir = path.join(testRoot, "home", "test");
    browserUtilsMock.configDir = configDir;
    realMkdirSync(configDir, { recursive: true, mode: 0o700 });
    realMkdirSync(path.join(homeDir, ".Trash"), { recursive: true, mode: 0o700 });
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
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
    const browserDir = path.join(configDir, "browser");
    realMkdirSync(browserDir, { recursive: true });
    const target = path.join(browserDir, name);
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

  it("allows managed browser data under a configured state directory outside home and temp", async () => {
    const { movePathToTrash } = await import("./trash.js");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    mockTrashContainer("secure");
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const target = path.join(configDir, "browser", "constructor");
    realMkdirSync(target, { recursive: true });
    const expected = path.join(homeDir, ".Trash", "constructor-123-secure", "constructor");

    await expect(movePathToTrash(target)).resolves.toBe(expected);
    expect(renameSync).toHaveBeenCalledWith(target, expected);
  });

  it("does not authorize other configured-state paths", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const target = path.join(configDir, "credentials", "token.json");
    realMkdirSync(path.dirname(target), { recursive: true });
    realWriteFileSync(target, "secret");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("does not grant arbitrary filesystem authority for a root config directory", async () => {
    browserUtilsMock.configDir = path.parse(testRoot).root;
    const { movePathToTrash } = await import("./trash.js");
    const target = path.join(testRoot, "outside-root-browser");
    realWriteFileSync(target, "outside");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("rejects browser-subtree symlinks that escape the configured state directory", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const browserDir = path.join(configDir, "browser");
    const outsideDir = path.join(testRoot, "outside-profile");
    realMkdirSync(browserDir, { recursive: true });
    realMkdirSync(outsideDir, { recursive: true });
    const target = path.join(browserDir, "constructor");
    fs.symlinkSync(outsideDir, target, "dir");

    await expect(movePathToTrash(target)).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
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
