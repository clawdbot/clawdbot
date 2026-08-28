#!/usr/bin/env node

import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./run-tsgo-core-test-shards.mts",
  failureTool: "tsgo:core:test",
});
