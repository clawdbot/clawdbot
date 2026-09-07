#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderSecretRefCredentialMatrixJson,
  renderSecretRefCredentialSurface,
} from "../src/secrets/credential-matrix-docs.js";
import { buildSecretRefCredentialMatrix } from "../src/secrets/credential-matrix.js";
import { getSecretTargetRegistry } from "../src/secrets/target-registry-data.js";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const write = args.has("--write");
if (check === write || args.size !== 1) {
  console.error("Usage: node --import tsx scripts/generate-secretref-docs.ts --check|--write");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const matrixPath = path.join(
  repoRoot,
  "docs/reference/secretref-user-supplied-credentials-matrix.json",
);
const surfacePath = path.join(repoRoot, "docs/reference/secretref-credential-surface.md");
const currentSurface = fs.readFileSync(surfacePath, "utf8");
const registry = getSecretTargetRegistry({
  sourceTree: true,
});
const matrix = buildSecretRefCredentialMatrix(registry);
const artifacts = [
  {
    path: matrixPath,
    current: fs.readFileSync(matrixPath, "utf8"),
    expected: renderSecretRefCredentialMatrixJson(matrix),
  },
  {
    path: surfacePath,
    current: currentSurface,
    expected: renderSecretRefCredentialSurface(currentSurface, matrix),
  },
];

const changed = artifacts.filter((artifact) => artifact.current !== artifact.expected);
if (check) {
  if (changed.length === 0) {
    console.log("SecretRef reference docs are up to date.");
    process.exit(0);
  }
  for (const artifact of changed) {
    console.error(`SecretRef docs drift: ${path.relative(repoRoot, artifact.path)}`);
  }
  console.error("Run `pnpm gen:secretref-docs` and commit the generated changes.");
  process.exit(1);
}

for (const artifact of changed) {
  fs.writeFileSync(artifact.path, artifact.expected, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, artifact.path)}`);
}
if (changed.length === 0) {
  console.log("SecretRef reference docs are already up to date.");
}
