#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { writeRuntimePostBuildStamp } from "./lib/local-build-metadata.mjs";

export {
  RUNTIME_POSTBUILD_STAMP_FILE,
  writeRuntimePostBuildStamp,
} from "./lib/local-build-metadata.mjs";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeRuntimePostBuildStamp();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
