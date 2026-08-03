#!/usr/bin/env node
// Verifies each generated Control UI sidecar encodes the final emitted asset bytes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(repoRoot, "dist", "control-ui", "assets");
const errors = [];
let checked = 0;

for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
  if (!entry.isFile()) {
    continue;
  }
  const suffix = entry.name.endsWith(".br") ? ".br" : entry.name.endsWith(".gz") ? ".gz" : null;
  if (!suffix) {
    continue;
  }
  const sidecarPath = path.join(assetsDir, entry.name);
  const sourcePath = sidecarPath.slice(0, -suffix.length);
  try {
    const encoded = fs.readFileSync(sidecarPath);
    const decoded = suffix === ".br" ? brotliDecompressSync(encoded) : gunzipSync(encoded);
    const source = fs.readFileSync(sourcePath);
    if (!decoded.equals(source)) {
      errors.push(`${entry.name}: decoded bytes differ from ${path.basename(sourcePath)}`);
    }
  } catch (error) {
    errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  checked += 1;
}

if (checked === 0) {
  errors.push("no precompressed Control UI assets found");
}
if (errors.length > 0) {
  throw new Error(`Control UI precompressed asset verification failed:\n${errors.join("\n")}`);
}

process.stdout.write(`verified ${checked} finalized Control UI sidecars\n`);
