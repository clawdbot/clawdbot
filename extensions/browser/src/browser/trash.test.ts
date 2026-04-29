import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw"));
const OPENCLAW_TMP_ROOT = "/tmp/openclaw";
const TRASH_SOURCE = `${OPENCLAW_TMP_ROOT}/demo`;

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

function mockTrashContainer(...suffixes: string[]) {
  let call = 0;
  return vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix) => {
    const suffix = suffixes[call] ?? "secure";
    call += 1;
    return `${prefix}${suffix}`;
  });
}

describe("browser trash", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolvePreferredOpenClawTmpDirMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReturnValue("/tmp/openclaw");
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
    vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
    vi.spyOn(fs, "lstatSync").mockReturnValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as fs.Stats);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) => String(candidate));
  });

  it("moves paths to a reserved user trash container without invoking a PATH-resolved command", async () => {
    const { movePathToTrash } = await import("./trash.js");
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const mkdtempSync = mockTrashContainer("secure");
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);
    const cpSync = vi.spyOn(fs, "cpSync");
    const rmSync = vi.spyOn(fs, "rmSync");

    await expect(movePathToTrash(TRASH_SOURCE)).resolves.toBe(
      "/home/test/.Trash/demo-123-secure/demo",
    );
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", {
      recursive: true,
      mode: 0o700,
    });
    expect(mkdtempSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123-");
    expect(renameSync).toHaveBeenCalledWith(TRASH_SOURCE, "/home/test/.Trash/demo-123-secure/demo");
    expect(cpSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("uses the resolved trash directory for reserved destinations", async () => {
    const { movePathToTrash } = await import("./trash.js");
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

    await expect(movePathToTrash(TRASH_SOURCE)).resolves.toBe(
      "/real/home/test/.Trash/demo-123-secure/demo",
    );
    expect(mkdtempSync).toHaveBeenCalledWith("/real/home/test/.Trash/demo-123-");
    expect(renameSync).toHaveBeenCalledWith(
      TRASH_SOURCE,
      "/real/home/test/.Trash/demo-123-secure/demo",
    );
  });

  it("refuses to trash filesystem roots", async () => {
    const { movePathToTrash } = await import("./trash.js");

    await expect(movePathToTrash("/")).rejects.toThrow("Refusing to trash root path");
  });

  it("refuses to trash paths outside allowed roots", async () => {
    const { movePathToTrash } = await import("./trash.js");

    await expect(movePathToTrash("/etc/openclaw-demo")).rejects.toThrow(
      "Refusing to trash path outside allowed roots",
    );
  });

  it("refuses to use a symlinked trash directory", async () => {
    const { movePathToTrash } = await import("./trash.js");
    vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "lstatSync").mockImplementation(
      (candidate) =>
        ({
          isDirectory: () => true,
          isSymbolicLink: () => String(candidate) === "/home/test/.Trash",
        }) as fs.Stats,
    );

    await expect(movePathToTrash(TRASH_SOURCE)).rejects.toThrow(
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

    await expect(movePathToTrash(TRASH_SOURCE)).resolves.toBe(
      "/home/test/.Trash/demo-123-secure/demo",
    );
    expect(cpSync).toHaveBeenCalledWith(TRASH_SOURCE, "/home/test/.Trash/demo-123-secure/demo", {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    expect(rmSync).toHaveBeenCalledWith(TRASH_SOURCE, { recursive: true, force: false });
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

    await expect(movePathToTrash(TRASH_SOURCE)).resolves.toBe(
      "/home/test/.Trash/demo-123-second/demo",
    );
    expect(cpSync).toHaveBeenNthCalledWith(
      1,
      TRASH_SOURCE,
      "/home/test/.Trash/demo-123-first/demo",
      {
        recursive: true,
        force: false,
        errorOnExist: true,
      },
    );
    expect(cpSync).toHaveBeenNthCalledWith(
      2,
      TRASH_SOURCE,
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

    await expect(movePathToTrash(TRASH_SOURCE)).resolves.toBe(
      "/home/test/.Trash/demo-123-second/demo",
    );
    expect(renameSync).toHaveBeenNthCalledWith(
      1,
      TRASH_SOURCE,
      "/home/test/.Trash/demo-123-first/demo",
    );
    expect(renameSync).toHaveBeenNthCalledWith(
      2,
      TRASH_SOURCE,
      "/home/test/.Trash/demo-123-second/demo",
    );
    expect(Date.now).toHaveBeenCalledTimes(1);
  });
});
