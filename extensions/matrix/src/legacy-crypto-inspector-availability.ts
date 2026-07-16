import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_CRYPTO_INSPECTOR_FILE = "legacy-crypto-inspector.js";
const LEGACY_CRYPTO_INSPECTOR_CHUNK_PREFIX = "legacy-crypto-inspector-";
const LEGACY_CRYPTO_INSPECTOR_HELPER_CHUNK_PREFIX = "availability-";
const JAVASCRIPT_MODULE_SUFFIX = ".js";

function isLegacyCryptoInspectorArtifactName(name: string): boolean {
  if (name === LEGACY_CRYPTO_INSPECTOR_FILE) {
    return true;
  }
  if (
    !name.startsWith(LEGACY_CRYPTO_INSPECTOR_CHUNK_PREFIX) ||
    !name.endsWith(JAVASCRIPT_MODULE_SUFFIX)
  ) {
    return false;
  }
  const chunkSuffix = name.slice(
    LEGACY_CRYPTO_INSPECTOR_CHUNK_PREFIX.length,
    -JAVASCRIPT_MODULE_SUFFIX.length,
  );
  return (
    chunkSuffix.length > 0 &&
    chunkSuffix !== "availability" &&
    !chunkSuffix.startsWith(LEGACY_CRYPTO_INSPECTOR_HELPER_CHUNK_PREFIX)
  );
}

function hasSourceInspectorArtifact(currentDir: string): boolean {
  return [
    path.resolve(currentDir, "matrix", "legacy-crypto-inspector.ts"),
    path.resolve(currentDir, "matrix", "legacy-crypto-inspector.js"),
  ].some((candidate) => fs.existsSync(candidate));
}

function hasBuiltInspectorArtifact(currentDir: string): boolean {
  if (fs.existsSync(path.join(currentDir, "legacy-crypto-inspector.js"))) {
    return true;
  }
  if (fs.existsSync(path.join(currentDir, "extensions", "matrix", "legacy-crypto-inspector.js"))) {
    return true;
  }
  return fs
    .readdirSync(currentDir, { withFileTypes: true })
    .some((entry) => entry.isFile() && isLegacyCryptoInspectorArtifactName(entry.name));
}

export function isMatrixLegacyCryptoInspectorAvailable(): boolean {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  if (hasSourceInspectorArtifact(currentDir)) {
    return true;
  }
  try {
    return hasBuiltInspectorArtifact(currentDir);
  } catch {
    return false;
  }
}
