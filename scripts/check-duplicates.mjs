import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./check-duplicates.mts",
  failureTool: "dup:check",
});
