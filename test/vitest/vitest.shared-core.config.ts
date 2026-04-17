import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { getUnitFastTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createSharedCoreVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/shared/**/*.test.ts"], {
    dir: "src",
    env,
    exclude: getUnitFastTestFiles(),
    includeOpenClawRuntimeSetup: false,
    name: "shared-core",
    passWithNoTests: true,
  });
}

export default createSharedCoreVitestConfig();
