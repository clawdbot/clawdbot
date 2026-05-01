import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  materializeBundledRuntimeMirrorFile,
  refreshBundledPluginRuntimeMirrorRoot,
} from "./bundled-runtime-mirror.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-mirror-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("refreshBundledPluginRuntimeMirrorRoot", () => {
  it("refreshes stale mirrors without leaving removed source files behind", () => {
    const root = makeTempRoot();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "old.js"), "export const value = 'v1';\n", "utf8");

    expect(
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: "demo",
        sourceRoot,
        targetRoot,
      }),
    ).toBe(true);

    fs.rmSync(path.join(sourceRoot, "old.js"));
    fs.writeFileSync(path.join(sourceRoot, "new.js"), "export const value = 'v2';\n", "utf8");

    expect(
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: "demo",
        sourceRoot,
        targetRoot,
      }),
    ).toBe(true);

    expect(fs.readdirSync(targetRoot).toSorted()).toEqual([
      ".openclaw-runtime-mirror.json",
      "new.js",
    ]);
    expect(fs.readFileSync(path.join(targetRoot, "new.js"), "utf8")).toContain("v2");
    expect(
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: "demo",
        sourceRoot,
        targetRoot,
      }),
    ).toBe(false);
  });

  it("replaces stale target entries when the source changes type", () => {
    const root = makeTempRoot();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");
    fs.mkdirSync(path.join(sourceRoot, "entry"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "entry", "index.js"), "export const value = 1;\n");

    expect(
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: "demo",
        sourceRoot,
        targetRoot,
      }),
    ).toBe(true);

    fs.rmSync(path.join(sourceRoot, "entry"), { recursive: true, force: true });
    fs.writeFileSync(path.join(sourceRoot, "entry"), "export const value = 2;\n");

    expect(
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: "demo",
        sourceRoot,
        targetRoot,
      }),
    ).toBe(true);

    expect(fs.lstatSync(path.join(targetRoot, "entry")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(targetRoot, "entry"), "utf8")).toContain("2");
  });

  it("replaces stale symlinked mirror roots before creating temp files", () => {
    const root = makeTempRoot();
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");
    const staleRoot = path.join(root, "stale-image-layer");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(staleRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "fresh.js"), "export const value = 'fresh';\n", "utf8");
    fs.symlinkSync(staleRoot, targetRoot, "dir");

    expect(
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: "demo",
        sourceRoot,
        targetRoot,
      }),
    ).toBe(true);

    expect(fs.lstatSync(targetRoot).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(targetRoot, "fresh.js"), "utf8")).toContain("fresh");
    expect(fs.existsSync(path.join(staleRoot, "fresh.js"))).toBe(false);
  });

  it("does not rewrite already materialized hardlinks", () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source.js");
    const targetPath = path.join(root, "target.js");
    fs.writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
    fs.linkSync(sourcePath, targetPath);
    const linkSpy = vi.spyOn(fs, "linkSync");
    const copySpy = vi.spyOn(fs, "copyFileSync");
    const renameSpy = vi.spyOn(fs, "renameSync");

    materializeBundledRuntimeMirrorFile(sourcePath, targetPath);

    expect(linkSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    expect(renameSpy).not.toHaveBeenCalled();
    const sourceStat = fs.lstatSync(sourcePath);
    const targetStat = fs.lstatSync(targetPath);
    expect({ dev: targetStat.dev, ino: targetStat.ino }).toEqual({
      dev: sourceStat.dev,
      ino: sourceStat.ino,
    });
  });
});
