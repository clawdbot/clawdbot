// Vitest ui config wires the ui test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";

export function createUiVitestConfig(
  env?: Record<string, string | undefined>,
  options?: { includePatterns?: string[]; name?: string },
) {
  const includePatterns = options?.includePatterns ?? ["ui/src/**/*.test.ts"];
  // Isolated files must never enter the shared module graph, including scoped runs.
  const exclude = ["ui/src/**/*.e2e.test.ts", ...uiIsolatedTestFiles];
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
    useNonIsolatedRunner: true,
  });
}

export default createUiVitestConfig();
