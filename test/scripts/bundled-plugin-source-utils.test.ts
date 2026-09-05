// Bundled Plugin Source Utils tests cover bundled plugin source utils script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectBundledPluginSources } from "../../scripts/lib/bundled-plugin-source-utils.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("scripts/lib/bundled-plugin-source-utils.mts", () => {
  it("discovers repo bundled plugin sources without scanning extension directories", () => {
    const payload = expectNoNodeFsScans<{
      channels: number;
      sources: number;
    }>(`
      const utils = await import("./scripts/lib/bundled-plugin-source-utils.mts");
      const sources = utils.collectBundledPluginSources({
        repoRoot: process.cwd(),
        requirePackageJson: true,
      });
      return {
        channels: sources.filter(
          (source) => Array.isArray(source.manifest?.channels) && source.manifest.channels.length > 0,
        ).length,
        sources: sources.length,
      };
    `);
    expect(payload.sources).toBeGreaterThan(0);
    expect(payload.channels).toBeGreaterThan(0);
  });

  it("ignores tracked plugin manifests deleted by the current change", async () => {
    const repoRoot = tempDirs.make("openclaw-bundled-plugin-sources-");
    const pluginDir = path.join(repoRoot, "extensions", "retired");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "retired", configSchema: {} }),
    );
    await fs.writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ name: "retired" }));
    expect(spawnSync("git", ["init", "-q"], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("git", ["add", "extensions"], { cwd: repoRoot }).status).toBe(0);
    await fs.rm(pluginDir, { recursive: true });

    expect(collectBundledPluginSources({ repoRoot, requirePackageJson: true })).toEqual([]);
  });
});
