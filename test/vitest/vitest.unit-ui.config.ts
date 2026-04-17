import { createUiVitestConfig, unitUiIncludePatterns } from "./vitest.ui.config.ts";

export default createUiVitestConfig(process.env, {
  includePatterns: unitUiIncludePatterns,
  name: "unit-ui",
});
