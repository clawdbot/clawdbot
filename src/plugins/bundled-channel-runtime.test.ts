/** Verifies bundled channel plugin runtime loading and channel ownership. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  resolveBundledChannelWorkspacePath,
} from "./bundled-channel-runtime.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-empty-bundled-root-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("bundled channel runtime metadata", () => {
  it("preserves explicit empty bundled roots", () => {
    const tempRoot = createTempRoot();

    expect(listBundledChannelPluginMetadata({ rootDir: tempRoot })).toStrictEqual([]);
    expect(resolveBundledChannelWorkspacePath({ rootDir: tempRoot, pluginId: "telegram" })).toBe(
      null,
    );
  });

  it("preserves explicit missing bundled scan roots", () => {
    const tempRoot = createTempRoot();
    const missingScanDir = path.join(tempRoot, "missing-extensions");

    expect(
      listBundledChannelPluginMetadata({ rootDir: tempRoot, scanDir: missingScanDir }),
    ).toStrictEqual([]);
  });

  it("prefers package-local dist entries over source checkout channel entries", () => {
    const tempRoot = createTempRoot();
    const pluginRoot = path.join(tempRoot, "extensions", "slack");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        tempRoot,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "slack",
        path.join(tempRoot, "extensions"),
      ),
    ).toBe(path.join(pluginRoot, "dist", "index.js"));
  });

  it("prefers package-local dist entries for absolute installed registry sources", () => {
    const tempRoot = createTempRoot();
    const pluginRoot = path.join(tempRoot, "extensions", "slack");
    const builtScanRoot = path.join(tempRoot, "dist", "extensions");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(builtScanRoot, "slack"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        tempRoot,
        {
          source: path.join(pluginRoot, "index.ts"),
          built: path.join(pluginRoot, "index.ts"),
        },
        "slack",
        builtScanRoot,
      ),
    ).toBe(path.join(pluginRoot, "dist", "index.js"));
  });
});
