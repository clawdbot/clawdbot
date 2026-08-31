import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePluginNpmProjectsDir } from "./install-paths.js";
import {
  listManagedPluginNpmProjectRootsSync,
  listManagedPluginNpmRoots,
} from "./npm-project-roots.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeNpmRoot(): string {
  const tempDir = tempDirs.make("openclaw-npm-project-roots-");
  return path.join(tempDir, "npm");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed npm project roots", () => {
  it("returns sorted project directories and skips files", async () => {
    const npmRoot = makeNpmRoot();
    const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
    const alpha = path.join(projectsDir, "alpha");
    const zulu = path.join(projectsDir, "zulu");
    fs.mkdirSync(alpha, { recursive: true });
    fs.mkdirSync(zulu);
    fs.writeFileSync(path.join(projectsDir, "metadata.json"), "{}", "utf8");

    expect(listManagedPluginNpmProjectRootsSync(npmRoot)).toEqual([alpha, zulu]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot, alpha, zulu]);
  });

  it("treats a missing projects directory as empty", async () => {
    const npmRoot = makeNpmRoot();

    expect(listManagedPluginNpmProjectRootsSync(npmRoot)).toEqual([]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot]);
  });

  it("treats a projects path that is a file as unavailable", async () => {
    const npmRoot = makeNpmRoot();
    fs.mkdirSync(npmRoot, { recursive: true });
    fs.writeFileSync(resolvePluginNpmProjectsDir(npmRoot), "not a directory", "utf8");

    expect(listManagedPluginNpmProjectRootsSync(npmRoot)).toEqual([]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot]);
  });

  it("propagates unrelated filesystem errors", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw error;
    });
    expect(() => listManagedPluginNpmProjectRootsSync("/fake/npm")).toThrow(error);

    vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(error);
    await expect(listManagedPluginNpmRoots("/fake/npm")).rejects.toThrow(error);
  });
});
