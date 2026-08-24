import { runTsxCliShim } from "./lib/tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  implementation: "./run-tsgo.mts",
  failureTool: "tsgo",
  // The implementation owns a detached compiler group and escalates after 5s.
  // Its outer shim must stay alive long enough to finish that cleanup.
  forceKillDelayMs: 10_000,
});
