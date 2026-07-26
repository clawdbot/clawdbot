// Vitest ui-isolated config runs jsdom ui tests that need a fresh module graph.
// The shared ui shard runs non-isolated for speed, but tests that spy on module
// internals and assert the component uses that spy must not share a module cache
// with stateful predecessor files (see UI_ISOLATED_TEST_FILES).
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { UI_ISOLATED_TEST_FILES } from "./vitest.ui.config.ts";

export function createUiIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(UI_ISOLATED_TEST_FILES, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    isolate: true,
    name: "ui-isolated",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    useNonIsolatedRunner: false,
  });
}

export default createUiIsolatedVitestConfig();
