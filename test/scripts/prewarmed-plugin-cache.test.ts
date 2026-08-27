import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  stageVerifiedPrewarmedPluginCache,
  verifyPrewarmedPluginCache,
} from "../../scripts/prewarmed-plugin-cache.mjs";
import { selectMacOSPrewarmedPluginCacheEntries } from "../../scripts/stage-macos-prewarmed-plugin-cache.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createCache() {
  const root = tempDirs.make("openclaw-prewarmed-plugin-cache-");
  const sourceDir = path.join(root, "source");
  const stageDir = path.join(root, "stage");
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(stageDir);
  const archiveFile = "openclaw-codex-2026.8.1.tgz";
  fs.writeFileSync(path.join(sourceDir, archiveFile), "plugin archive\n");
  const archiveSHA256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(sourceDir, archiveFile)))
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    appVersion: "2026.8.1",
    gitCommit: "a".repeat(40),
    plugins: [
      {
        pluginId: "codex",
        packageName: "@openclaw/codex",
        packageVersion: "2026.8.1",
        npmSpec: "@openclaw/codex@2026.8.1",
        archiveFile,
        archiveSHA256,
      },
    ],
  };
  const manifestPath = path.join(sourceDir, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const manifestSHA256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(manifestPath))
    .digest("hex");
  return { sourceDir, stageDir, manifestPath, manifestSHA256, manifest };
}

describe("prewarmed plugin cache", () => {
  it("stages and revalidates exact cache contents", () => {
    const fixture = createCache();
    const result = stageVerifiedPrewarmedPluginCache({
      sourceDir: fixture.sourceDir,
      stageDir: fixture.stageDir,
      expectedVersion: "2026.8.1",
      expectedCommit: "a".repeat(40),
      expectedManifestSha256: fixture.manifestSHA256,
    });

    expect(result.plugins).toEqual(fixture.manifest.plugins);
    expect(fs.readdirSync(fixture.stageDir).toSorted()).toEqual([
      "manifest.json",
      "openclaw-codex-2026.8.1.tgz",
    ]);
  });

  it("rejects tampered archives and unexpected files", () => {
    const fixture = createCache();
    fs.appendFileSync(path.join(fixture.sourceDir, fixture.manifest.plugins[0]!.archiveFile), "x");
    expect(() =>
      verifyPrewarmedPluginCache({
        sourceDir: fixture.sourceDir,
        expectedVersion: "2026.8.1",
        expectedCommit: "a".repeat(40),
      }),
    ).toThrow("archive SHA-256 mismatch");

    const second = createCache();
    fs.writeFileSync(path.join(second.sourceDir, "unexpected"), "x");
    expect(() =>
      verifyPrewarmedPluginCache({
        sourceDir: second.sourceDir,
        expectedVersion: "2026.8.1",
        expectedCommit: "a".repeat(40),
      }),
    ).toThrow("unexpected or missing files");
  });

  it("selects every publishable external plugin in the checkout", () => {
    const selected = selectMacOSPrewarmedPluginCacheEntries(process.cwd());
    expect(selected).toHaveLength(89);
    expect(selected.every((plugin) => path.isAbsolute(plugin.packageDir))).toBe(true);
    expect(selected.some((plugin) => plugin.pluginId === "codex")).toBe(true);
    expect(selected.every((plugin) => plugin.version === "2026.8.1")).toBe(true);
  });
});
