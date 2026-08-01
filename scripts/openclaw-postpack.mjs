#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
// Restores every source artifact temporarily rewritten for npm packaging.
import { restorePackageChangelog } from "./package-changelog.mjs";
import { restorePackageDocsMap } from "./package-docs-map.mjs";

export async function restorePrepackArtifacts(cwd = process.cwd()) {
  const failures = [];
  try {
    await restorePackageChangelog(cwd);
  } catch (error) {
    failures.push(error);
  }
  try {
    // Release the docs-map receipt only after every other source artifact settles.
    await restorePackageDocsMap(cwd);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to restore prepack source artifacts.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await restorePrepackArtifacts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
