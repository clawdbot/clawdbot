import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";

export const unitUiIncludePatterns = [
  "ui/src/ui/app-chat.test.ts",
  "ui/src/ui/chat/**/*.test.ts",
  "ui/src/ui/views/agents-utils.test.ts",
  "ui/src/ui/views/channels.test.ts",
  "ui/src/ui/views/chat.test.ts",
  "ui/src/ui/views/dreams.test.ts",
  "ui/src/ui/views/usage-render-details.test.ts",
  "ui/src/ui/controllers/agents.test.ts",
  "ui/src/ui/controllers/chat.test.ts",
];

export function createUiVitestConfig(
  env?: Record<string, string | undefined>,
  options?: { includePatterns?: string[]; name?: string },
) {
  return createScopedVitestConfig(options?.includePatterns ?? ["ui/src/ui/**/*.test.ts"], {
    deps: jsdomOptimizedDeps,
    dir: "ui/src/ui",
    environment: "jsdom",
    env,
    excludeUnitFastTests: false,
    includeOpenClawRuntimeSetup: false,
    isolate: true,
    name: options?.name ?? "ui",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
  });
}

export default createUiVitestConfig();
