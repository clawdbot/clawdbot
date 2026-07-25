import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      expect("cleanup" in autoCleanupTracker).toBe(false);
    });
  });
});
