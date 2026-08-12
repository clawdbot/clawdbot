import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./run-oxlint.mts",
  failureTool: "oxlint",
});
