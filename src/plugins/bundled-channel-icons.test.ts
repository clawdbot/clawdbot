// Verifies every bundled channel publishes complete package-local presentation metadata.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";

type ChannelManifest = {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  channels?: string[];
};

describe("bundled channel icons", () => {
  it("packages a fixed local 512px PNG for every channel plugin", () => {
    const manifestPaths = listGitTrackedFiles({
      repoRoot,
      pathspecs: "extensions/*/openclaw.plugin.json",
    });
    expect(manifestPaths).not.toBeNull();
    const channelPlugins = (manifestPaths ?? []).flatMap((manifestPath) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, manifestPath), "utf8"),
      ) as ChannelManifest;
      return manifest.channels?.length ? [{ manifest, manifestPath }] : [];
    });
    expect(channelPlugins.length).toBeGreaterThan(0);

    for (const { manifest, manifestPath } of channelPlugins) {
      expect(manifest.name?.trim(), `${manifest.id} channel label`).toBeTruthy();
      expect(manifest.description?.trim(), `${manifest.id} channel description`).toBeTruthy();
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
