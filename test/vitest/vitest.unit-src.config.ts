import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

export default createUnitVitestConfigWithOptions(process.env, {
  name: "unit-src",
  includePatterns: ["src/**/*.test.ts"],
  extraExcludePatterns: ["src/acp/**", "src/security/**"],
});
