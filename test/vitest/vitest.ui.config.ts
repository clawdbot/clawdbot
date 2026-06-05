// Vitest ui config wires the ui test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { unitUiIncludePatterns } from "./vitest.ui-paths.mjs";

export function createUiVitestConfig(
  env?: Record<string, string | undefined>,
  options?: { includePatterns?: string[]; name?: string },
) {
  const includePatterns = options?.includePatterns ?? ["ui/src/**/*.test.ts"];
  const exclude = options?.includePatterns
    ? []
    : [...unitUiIncludePatterns, "ui/src/**/*.e2e.test.ts"];
  return createScopedVitestConfig(includePatterns, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    exclude,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    isolate: false,
    name: options?.name ?? "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
  });
}

export default createUiVitestConfig();
