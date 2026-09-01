import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONTROL_UI_ASSET_MANIFEST_VERSION,
  hashControlUiAssetManifestEntries,
  type ControlUiAssetManifest,
  type ControlUiAssetManifestEntry,
} from "./control-ui-asset-manifest.js";

const CONTROL_UI_ASSET_SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_UI_ASSET_MANIFEST_MAX_ENTRIES = 8192;
const CONTROL_UI_ASSET_MANIFEST_MAX_FILE_BYTES = 64 * 1024 * 1024;
const CONTROL_UI_ASSET_MANIFEST_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isControlUiAssetManifestPath(value: string): boolean {
  if (!value.startsWith("assets/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    !path.posix.isAbsolute(normalized) &&
    !normalized.endsWith("/") &&
    !normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

export function parseControlUiAssetManifest(value: unknown): ControlUiAssetManifest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["assets", "generation", "version"])) {
    return null;
  }
  if (
    value.version !== CONTROL_UI_ASSET_MANIFEST_VERSION ||
    typeof value.generation !== "string" ||
    !CONTROL_UI_ASSET_SHA256_PATTERN.test(value.generation) ||
    !Array.isArray(value.assets) ||
    value.assets.length === 0 ||
    value.assets.length > CONTROL_UI_ASSET_MANIFEST_MAX_ENTRIES
  ) {
    return null;
  }

  const assets: ControlUiAssetManifestEntry[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value.assets) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["path", "sha256", "size"])) {
      return null;
    }
    const assetPath = candidate.path;
    const size = candidate.size;
    const sha256 = candidate.sha256;
    if (
      typeof assetPath !== "string" ||
      !isControlUiAssetManifestPath(assetPath) ||
      paths.has(assetPath) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > CONTROL_UI_ASSET_MANIFEST_MAX_FILE_BYTES ||
      typeof sha256 !== "string" ||
      !CONTROL_UI_ASSET_SHA256_PATTERN.test(sha256)
    ) {
      return null;
    }
    totalBytes += size;
    if (totalBytes > CONTROL_UI_ASSET_MANIFEST_MAX_TOTAL_BYTES) {
      return null;
    }
    paths.add(assetPath);
    assets.push({ path: assetPath, sha256, size });
  }

  const sorted = assets.toSorted((left, right) => left.path.localeCompare(right.path));
  if (sorted.some((entry, index) => entry.path !== assets[index]?.path)) {
    return null;
  }
  if (hashControlUiAssetManifestEntries(assets) !== value.generation) {
    return null;
  }
  return {
    version: CONTROL_UI_ASSET_MANIFEST_VERSION,
    generation: value.generation,
    assets,
  };
}
