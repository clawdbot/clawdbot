import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshBundledPluginRuntimeMirrorRoot } from "./bundled-runtime-mirror.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-mirror-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
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
});
