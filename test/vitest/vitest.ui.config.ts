// Vitest ui config wires the ui test shard.
import type { ViteUserConfig } from "vitest/config";
import { controlUiLocaleModulesPlugin } from "../../ui/config/control-ui-locales.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";
import {
  controlUiE2eTestGlobs,
  controlUiTestGlobs,
  uiNodeDrivenBrowserTestFiles,
} from "./vitest.ui-paths.mjs";

// Explicit nameable return type: inference reaches vite-internal names (TS4058/TS4082).
export function createUiVitestConfig(env?: Record<string, string | undefined>): ViteUserConfig {
  const includePatterns = [
    ...controlUiTestGlobs.map((pattern) => pattern.replace("*.test.ts", "!(*.browser).test.ts")),
    ...uiNodeDrivenBrowserTestFiles,
  ];
  // Isolated files must never enter the shared module graph, including scoped runs.
  const exclude = [...controlUiE2eTestGlobs, ...uiIsolatedTestFiles];
  const config = createScopedVitestConfig(includePatterns, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    exclude,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    intersectIncludeFile: true,
    isolate: false,
    name: "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    useNonIsolatedRunner: true,
  });
  return { ...config, plugins: [...(config.plugins ?? []), controlUiLocaleModulesPlugin()] };
}

export default createUiVitestConfig();
