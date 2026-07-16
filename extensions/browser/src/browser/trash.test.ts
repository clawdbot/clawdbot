import fs from "node:fs";
import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runExec = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runExec,
}));

describe("browser trash", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runExec.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.spyOn(os, "homedir").mockReturnValue("/home/test");
  });

  it("returns the target path when trash exits successfully", async () => {
    const { movePathToTrash } = await import("./trash.js");
    runExec.mockResolvedValue(undefined);
    const mkdirSync = vi.spyOn(fs, "mkdirSync");
    const renameSync = vi.spyOn(fs, "renameSync");

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/tmp/demo");
    expect(runExec).toHaveBeenCalledWith("trash", ["/tmp/demo"], { timeoutMs: 10_000 });
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
  });

  it("falls back to rename when trash exits non-zero", async () => {
    const { movePathToTrash } = await import("./trash.js");
    runExec.mockRejectedValue(new Error("permission denied"));
    const mkdirSync = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const existsSync = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const renameSync = vi.spyOn(fs, "renameSync").mockImplementation(() => undefined);

    await expect(movePathToTrash("/tmp/demo")).resolves.toBe("/home/test/.Trash/demo-123");
    expect(mkdirSync).toHaveBeenCalledWith("/home/test/.Trash", { recursive: true });
    expect(existsSync).toHaveBeenCalledWith("/home/test/.Trash/demo-123");
    expect(renameSync).toHaveBeenCalledWith("/tmp/demo", "/home/test/.Trash/demo-123");
  });
});
