import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

export default createUnitVitestConfigWithOptions(process.env, {
  name: "unit-security",
  includePatterns: ["src/security/**/*.test.ts"],
  passWithNoTests: true,
});
