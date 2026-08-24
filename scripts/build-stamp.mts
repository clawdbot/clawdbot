#!/usr/bin/env node

// Writes the local build stamp and re-exports build metadata helpers.
import process from "node:process";
import { pathToFileURL } from "node:url";
import { writeBuildStamp } from "./lib/local-build-metadata.mts";

export { BUILD_STAMP_FILE, resolveGitHead, writeBuildStamp } from "./lib/local-build-metadata.mts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeBuildStamp();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
