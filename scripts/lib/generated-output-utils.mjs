// Shared write/check/report helpers for generated repository files.
import path from "node:path";
import { writeTextFileIfChanged } from "../runtime-postbuild-shared.mjs";
import { readIfExists } from "./bundled-plugin-source-utils.mjs";

/** Write generated output unless check mode only needs stale-state metadata. */
export function writeGeneratedOutput(params) {
  const outputPath = path.resolve(params.repoRoot, params.outputPath);
  const current = readIfExists(outputPath);
  const changed = current !== params.next;

  if (params.check) {
    return {
      changed,
      wrote: false,
      outputPath,
    };
  }

  return {
    changed,
    wrote: writeTextFileIfChanged(outputPath, params.next),
    outputPath,
  };
}
