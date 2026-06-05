// Shared write/check/report helpers for generated repository files.
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** Report generated-output CLI results when the current module is run directly. */
export function reportGeneratedOutputCli(params) {
  if (params.importMetaUrl !== pathToFileURL(process.argv[1] ?? "").href) {
    return;
  }

  const check = process.argv.includes("--check");
  const result = params.run({ check });
  if (!result.changed) {
    return;
  }

  const relativeOutputPath = path.relative(process.cwd(), result.outputPath);
  if (check) {
    console.error(`[${params.label}] stale generated output at ${relativeOutputPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[${params.label}] wrote ${relativeOutputPath}`);
}
