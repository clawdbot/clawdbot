// Vitest unit ui config wires the unit ui test shard.
import { unitUiIncludePatterns } from "./vitest.ui-paths.mjs";
import { createUiVitestConfig } from "./vitest.ui.config.ts";

export default createUiVitestConfig(process.env, {
  includePatterns: unitUiIncludePatterns,
  name: "unit-ui",
});
