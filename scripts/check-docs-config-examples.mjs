#!/usr/bin/env node
import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./check-docs-config-examples.mts",
  failureTool: "check-docs-config-examples",
});
