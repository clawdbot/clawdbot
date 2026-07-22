// Vitest ui config wires the ui test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import { jsdomOptimizedDeps } from "./vitest.shared.config.ts";

// Full chat-pane lifecycle tests instantiate the pane component, which relies on
// chat-thread/chat-message module-level singletons (thread state maps, module-scoped
// document context-menu listeners) and spies on those modules. Under the non-isolated
// ui runner a stateful predecessor file can leave those modules duplicated across the
// shared graph, so the pane binds to a different instance than the test's spy/registry
// — surfacing as flaky teardown assertions or 120s session-lifecycle hangs, depending
// on file order. These tests run in the isolated ui lane for a fresh module graph;
// keep this list in sync with vitest.ui-isolated.config.ts's include.
export const UI_ISOLATED_TEST_FILES = [
  "ui/src/pages/chat/chat-pane-history.test.ts",
  "ui/src/pages/chat/chat-pane-lifecycle.test.ts",
  "ui/src/pages/chat/chat-pane-pull-requests.test.ts",
  "ui/src/pages/chat/chat-pane.message-cut.test.ts",
  "ui/src/pages/chat/chat-pane.read-marker.test.ts",
  "ui/src/pages/chat/chat-pane.session-discussion.test.ts",
  "ui/src/pages/chat/chat-pane.test.ts",
];

export function createUiVitestConfig(
  env?: Record<string, string | undefined>,
  options?: { includePatterns?: string[]; name?: string },
) {
  const includePatterns = options?.includePatterns ?? ["ui/src/**/*.test.ts"];
  const exclude = options?.includePatterns
    ? []
    : ["ui/src/**/*.e2e.test.ts", ...UI_ISOLATED_TEST_FILES];
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
