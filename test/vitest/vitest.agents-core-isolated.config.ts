// Vitest agents core isolated config separates suites with conflicting module mocks.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsCoreIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.coreIsolated;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    isolate: true,
    name: owner.name,
    passWithNoTests: true,
    useNonIsolatedRunner: false,
  });
}

export default createAgentsCoreIsolatedVitestConfig();
