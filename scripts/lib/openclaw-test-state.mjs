import { runTsxCliShim } from "./tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./openclaw-test-state.mts",
});
