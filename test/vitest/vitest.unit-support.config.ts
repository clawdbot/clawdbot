import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

export default createUnitVitestConfigWithOptions(process.env, {
  name: "unit-support",
  includePatterns: ["packages/**/*.test.ts"],
  passWithNoTests: true,
});
