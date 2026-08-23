#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
// Restores every source artifact temporarily rewritten for npm packaging.
import { restorePackageChangelog } from "./package-changelog.mjs";
import { restorePackageDocsMap } from "./package-docs-map.mjs";
import { restorePackageManifest } from "./package-manifest.mjs";

export async function restorePrepackArtifacts(cwd = process.cwd()) {
  await restorePackageChangelog(cwd);
  await restorePackageManifest(cwd);
  // Release the lifecycle receipt only after every other source mutation settles.
  await restorePackageDocsMap(cwd);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await restorePrepackArtifacts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
