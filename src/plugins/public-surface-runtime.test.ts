import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PUBLIC_SURFACE_SOURCE_EXTENSIONS,
  normalizeBundledPluginArtifactSubpath,
  normalizeBundledPluginDirName,
  resolveBundledPluginPublicSurfacePath,
  resolveBundledPluginSourcePublicSurfacePath,
} from "./public-surface-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-public-surface-runtime-"));
  tempDirs.push(tempDir);
  return tempDir;
}

describe("bundled plugin public surface runtime", () => {
  it("exports the canonical public surface source extension list", () => {
    expect(PUBLIC_SURFACE_SOURCE_EXTENSIONS).toEqual([
      ".ts",
      ".mts",
      ".js",
      ".mjs",
      ".cts",
      ".cjs",
    ]);
  });

  it("resolves source public surfaces from the shared extension list", () => {
    const sourceRoot = createTempDir();
    const modulePath = path.join(sourceRoot, "demo", "api.mts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, "export {};\n", "utf8");

    expect(
      resolveBundledPluginSourcePublicSurfacePath({
        sourceRoot,
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBe(modulePath);
  });

  it("falls back from package dist overrides to the source extension tree", () => {
    const packageRoot = createTempDir();
    const sourceModulePath = path.join(packageRoot, "extensions", "demo", "api.ts");
    fs.mkdirSync(path.dirname(sourceModulePath), { recursive: true });
    fs.writeFileSync(sourceModulePath, "export const marker = 'source';\n", "utf8");

    const bundledPluginsDir = path.join(packageRoot, "dist", "extensions");
    fs.mkdirSync(path.join(bundledPluginsDir, "demo"), { recursive: true });

    expect(
      resolveBundledPluginPublicSurfacePath({
        rootDir: packageRoot,
        bundledPluginsDir,
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBe(sourceModulePath);
  });

  it("allows plugin-local nested artifact paths", () => {
    expect(normalizeBundledPluginArtifactSubpath("src/outbound-adapter.js")).toBe(
      "src/outbound-adapter.js",
    );
    expect(normalizeBundledPluginArtifactSubpath("./test-api.js")).toBe("test-api.js");
  });

  it("rejects artifact paths that escape the plugin root", () => {
    expect(() => normalizeBundledPluginArtifactSubpath("../outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("src/../outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("/tmp/outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("..\\outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("C:outside.js")).toThrow(
      /must stay plugin-local/,
    );
    expect(() => normalizeBundledPluginArtifactSubpath("src/C:outside.js")).toThrow(
      /must stay plugin-local/,
    );
  });

  it("rejects bundled plugin directory traversal", () => {
    expect(normalizeBundledPluginDirName("document-extract")).toBe("document-extract");
    expect(() => normalizeBundledPluginDirName("../outside")).toThrow(/single directory/);
    expect(() => normalizeBundledPluginDirName("nested/plugin")).toThrow(/single directory/);
    expect(() => normalizeBundledPluginDirName("nested\\plugin")).toThrow(/single directory/);
    expect(() => normalizeBundledPluginDirName("C:plugin")).toThrow(/single directory/);
  });
});
