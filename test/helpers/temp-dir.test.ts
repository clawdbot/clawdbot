import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  createTempDirTracker,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "./temp-dir.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("temp-dir test helpers", () => {
  it("keeps a non-executed temp warning fixture for CI proof", () => {
    // openclaw-temp-dir: allow test fixture for the temp warning report
    const warningFixture = 'tmp.dirSync({ prefix: "openclaw-warning-fixture-" })';

    expect(warningFixture).toContain("tmp.dirSync");
  });

  it("tracks created temp dirs and removes populated dirs", () => {
    const tracker = createTempDirTracker();
    const dir = tracker.make("openclaw-temp-dir-helper-");
    tempDirs.add(dir);
    fs.writeFileSync(path.join(dir, "artifact.txt"), "artifact\n", "utf8");

    tracker.cleanup();
    tempDirs.delete(dir);

    expect(fs.existsSync(dir)).toBe(false);
    expect([...tracker.dirs]).toEqual([]);
  });

  it("supports existing caller-owned temp dir collections", () => {
    const dir = makeTempDir(tempDirs, "openclaw-temp-dir-existing-");
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });

    cleanupTempDirs(tempDirs);

    expect(fs.existsSync(dir)).toBe(false);
    expect([...tempDirs]).toEqual([]);
  });

  it("creates default temp dirs under the canonical system temp path", () => {
    const dir = makeTempDir(tempDirs, "openclaw-temp-dir-canonical-");

    expect(dir.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)).toBe(true);
  });

  it("caches canonical system temp roots by their raw path", () => {
    const firstRoot = makeTempDir(tempDirs, "openclaw-temp-dir-cache-first-");
    const secondRoot = makeTempDir(tempDirs, "openclaw-temp-dir-cache-second-");
    const tmpdir = vi.spyOn(os, "tmpdir");
    const realpath = vi.spyOn(fs, "realpathSync");
    realpath.mockClear();

    tmpdir.mockReturnValue(firstRoot);
    const firstChild = makeTempDir(tempDirs, "child-");
    const cachedChild = makeTempDir(tempDirs, "child-");
    tmpdir.mockReturnValue(secondRoot);
    const secondChild = makeTempDir(tempDirs, "child-");

    expect(realpath).toHaveBeenCalledTimes(2);
    expect(realpath).toHaveBeenNthCalledWith(1, firstRoot);
    expect(realpath).toHaveBeenNthCalledWith(2, secondRoot);
    expect(firstChild.startsWith(`${firstRoot}${path.sep}`)).toBe(true);
    expect(cachedChild.startsWith(`${firstRoot}${path.sep}`)).toBe(true);
    expect(secondChild.startsWith(`${secondRoot}${path.sep}`)).toBe(true);
    realpath.mockRestore();
    tmpdir.mockRestore();
  });

  it("preserves the spelling of explicit custom roots", () => {
    const parent = makeTempDir(tempDirs, "openclaw-temp-dir-explicit-root-");
    const realRoot = path.join(parent, "real");
    const aliasRoot = path.join(parent, "alias");
    fs.mkdirSync(realRoot);
    fs.symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

    const dir = makeTempDir(tempDirs, "child-", aliasRoot);

    expect(dir.startsWith(`${aliasRoot}${path.sep}`)).toBe(true);
    expect(fs.realpathSync(dir).startsWith(`${realRoot}${path.sep}`)).toBe(true);
  });

  describe("auto-cleaning tracker", () => {
    const createdDirs: string[] = [];

    afterEach(() => {
      for (const dir of createdDirs.splice(0)) {
        expect(fs.existsSync(dir)).toBe(false);
      }
      expect([...autoCleanupTracker.dirs]).toEqual([]);
    });

    const autoCleanupTracker = useAutoCleanupTempDirTracker(afterEach);

    it("tracks temp dirs with Vitest cleanup", () => {
      const autoCleanedDir = autoCleanupTracker.make("openclaw-temp-dir-auto-");
      createdDirs.push(autoCleanedDir);
      fs.writeFileSync(path.join(autoCleanedDir, "artifact.txt"), "artifact\n", "utf8");

      expect(fs.existsSync(autoCleanedDir)).toBe(true);
    });
  });
});
