// Copy Bundled Plugin Metadata tests cover copy bundled plugin metadata script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("copyBundledPluginMetadata", () => {
  it("accepts a workspace without generated output roots", () => {
    const rootDir = createTempDir("openclaw-copy-metadata-");
    fs.mkdirSync(path.join(rootDir, "extensions"), { recursive: true });

    expect(() => copyBundledPluginMetadata({ cwd: rootDir })).not.toThrow();
  });

  it("refuses to remove dist plugin trees through a symlinked dist root", () => {
    const rootDir = createTempDir("openclaw-copy-metadata-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "telegram", "index.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "export {};\n");
    fs.mkdirSync(path.join(rootDir, "extensions", "telegram"), { recursive: true });
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => copyBundledPluginMetadata({ cwd: rootDir })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expect(fs.readFileSync(pluginFile, "utf8")).toBe("export {};\n");
  });
});
