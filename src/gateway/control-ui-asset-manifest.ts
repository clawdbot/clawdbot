// Build-owned inventory for immutable Control UI assets.
import { createHash } from "node:crypto";

export const CONTROL_UI_ASSET_MANIFEST_FILENAME = "asset-manifest.json";
export const CONTROL_UI_ASSET_MANIFEST_VERSION = 1;

export type ControlUiAssetManifestEntry = {
  path: string;
  sha256: string;
  size: number;
};

export type ControlUiAssetManifest = {
  assets: ControlUiAssetManifestEntry[];
  generation: string;
  version: typeof CONTROL_UI_ASSET_MANIFEST_VERSION;
};

export function hashControlUiAssetManifestEntries(
  entries: readonly ControlUiAssetManifestEntry[],
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(String(entry.size));
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}
