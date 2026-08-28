import { describe, expect, it } from "vitest";
import { parseControlUiAssetManifest } from "./control-ui-asset-manifest-parse.js";
import {
  CONTROL_UI_ASSET_MANIFEST_VERSION,
  hashControlUiAssetManifestEntries,
  type ControlUiAssetManifestEntry,
} from "./control-ui-asset-manifest.js";

function createControlUiAssetManifest(entries: ControlUiAssetManifestEntry[]) {
  const assets = entries.toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    version: CONTROL_UI_ASSET_MANIFEST_VERSION,
    generation: hashControlUiAssetManifestEntries(assets),
    assets,
  };
}

describe("Control UI asset manifest", () => {
  it("round-trips a canonical flat asset inventory", () => {
    const manifest = createControlUiAssetManifest([
      { path: "assets/z.js.gz", sha256: "b".repeat(64), size: 11 },
      { path: "assets/a.js", sha256: "a".repeat(64), size: 7 },
    ]);

    expect(manifest.assets.map((entry) => entry.path)).toEqual(["assets/a.js", "assets/z.js.gz"]);
    expect(parseControlUiAssetManifest(structuredClone(manifest))).toEqual(manifest);
  });

  it.each([
    "assets/../index.html",
    "assets/nested/../../escape.js",
    "assets\\app.js",
    "/assets/app.js",
  ])("rejects unsafe inventory path %s", (assetPath) => {
    const manifest = createControlUiAssetManifest([
      { path: assetPath, sha256: "a".repeat(64), size: 7 },
    ]);

    expect(parseControlUiAssetManifest(manifest)).toBeNull();
  });

  it("rejects an inventory whose bytes no longer match its generation", () => {
    const manifest = createControlUiAssetManifest([
      { path: "assets/app.js", sha256: "a".repeat(64), size: 7 },
    ]);
    manifest.assets[0] = { ...manifest.assets[0]!, size: 8 };

    expect(parseControlUiAssetManifest(manifest)).toBeNull();
  });
});
