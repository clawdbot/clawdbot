import { runTsxCliShim } from "../lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./kitchen-sink-rpc-walk.mts",
});
