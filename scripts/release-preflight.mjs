#!/usr/bin/env node
import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--macos-versions-only") {
  // Evidence reuse runs before dependencies exist; only this file-read-only probe bypasses tsx.
  const { writeFailedTrailer } = await import("./lib/failed-trailer.mts");
  process.once("exit", (exitCode) => writeFailedTrailer("release-preflight", exitCode));
  await import("./release-preflight.mts");
} else {
  await runTsxCliShim(import.meta.url, {
    implementation: "./release-preflight.mts",
    failureTool: "release-preflight",
  });
}
