#!/usr/bin/env node
import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./report-test-temp-creations.mts",
  failureTool: "test-temp-creations",
});
