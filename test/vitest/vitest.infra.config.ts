import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { boundaryTestFiles } from "./vitest.unit-paths.mjs";

export function createInfraVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/infra/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: boundaryTestFiles,
    isolate: true,
    name: "infra",
    passWithNoTests: true,
  });
}

export default createInfraVitestConfig();
