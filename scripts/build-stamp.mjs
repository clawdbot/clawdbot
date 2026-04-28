#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { writeBuildStamp } from "./lib/local-build-metadata.mjs";

export { BUILD_STAMP_FILE, resolveGitHead, writeBuildStamp } from "./lib/local-build-metadata.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeBuildStamp();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
