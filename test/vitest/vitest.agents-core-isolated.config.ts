// Vitest agents core isolated config separates suites with conflicting module mocks.
import { agentsCoreIsolatedTestFiles } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsCoreIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(agentsCoreIsolatedTestFiles, {
    dir: "src/agents",
    env,
    isolate: true,
    name: "agents-core-isolated",
    passWithNoTests: true,
    useNonIsolatedRunner: false,
  });
}

export default createAgentsCoreIsolatedVitestConfig();
