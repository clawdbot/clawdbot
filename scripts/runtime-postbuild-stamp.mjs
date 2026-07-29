#!/usr/bin/env node
// Writes the runtime postbuild stamp after generated runtime artifacts are current.
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
