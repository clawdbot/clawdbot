import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./copy-bundled-plugin-metadata.mts",
});
