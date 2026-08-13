// Vitest tooling isolated config wires the tooling isolated test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { toolingIsolatedTestFiles } from "./vitest.tooling-isolated-paths.mjs";

export function createToolingIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(toolingIsolatedTestFiles, {
    env,
    // Explicit tooling ownership must include thin wrappers even when static
    // analysis also classifies them as unit-fast candidates.
    excludeUnitFastTests: false,
    isolate: true,
    name: "tooling-isolated",
    passWithNoTests: true,
    useNonIsolatedRunner: false,
  });
}

export default createToolingIsolatedVitestConfig();
