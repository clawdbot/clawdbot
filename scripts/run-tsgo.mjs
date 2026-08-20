import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./run-tsgo.mts",
  failureTool: "tsgo",
});
