// Verifies every bundled plugin publishes a fixed package-local icon asset.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";

type BundledPluginManifest = {
  id: string;
  icon?: string;
};

describe("bundled plugin icons", () => {
  it("packages a fixed local 512px PNG for every bundled plugin", () => {
    const manifestPaths = listGitTrackedFiles({
      repoRoot,
      pathspecs: "extensions/*/openclaw.plugin.json",
    });
    expect(manifestPaths).not.toBeNull();
    const bundledManifestPaths = (manifestPaths ?? []).filter((manifestPath) =>
      /^extensions\/[^/]+\/openclaw\.plugin\.json$/u.test(manifestPath),
    );
    expect(bundledManifestPaths.length).toBeGreaterThan(0);

    for (const manifestPath of bundledManifestPaths) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"),
      ) as BundledPluginManifest;
      const pluginDir = path.dirname(path.join(repoRoot, manifestPath));
      const icon = fs.readFileSync(path.join(pluginDir, "assets", "icon.png"));
      expect(icon.subarray(0, 8), `${manifest.id} PNG signature`).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(icon.readUInt32BE(16), `${manifest.id} icon width`).toBe(512);
      expect(icon.readUInt32BE(20), `${manifest.id} icon height`).toBe(512);
      expect(manifest.icon, `${manifest.id} should not fetch a runtime icon URL`).toBeUndefined();
    }
  });
});
