import { runTsxCliShim } from "./tsx-cli-shim.mjs";

await runTsxCliShim(import.meta.url, {
  // The managed child owner may spend 5s on TERM grace and another 5s
  // verifying tree exit. Keep the launcher alive beyond that cleanup window.
  forceKillDelayMs: 15_000,
  implementation: "./bounded-command.mts",
});
