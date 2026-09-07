// Prune Docker Plugin Dist tests cover prune docker plugin dist script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneDockerPluginDist } from "../../scripts/prune-docker-plugin-dist.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("pruneDockerPluginDist", () => {
  it("refuses to prune plugin trees through a symlinked dist root", () => {
    const rootDir = createTempDir("openclaw-prune-docker-dist-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "telegram", "index.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "export {};\n");
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => pruneDockerPluginDist({ cwd: rootDir, env: {} })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expect(fs.readFileSync(pluginFile, "utf8")).toBe("export {};\n");
  });
});
