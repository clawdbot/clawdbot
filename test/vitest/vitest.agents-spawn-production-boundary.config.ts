// Vitest production spawn boundary config owns one module-mocking suite in a dedicated worker.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsSpawnProductionBoundaryVitestConfig(
  env?: Record<string, string | undefined>,
) {
  const owner = agentVitestProjectOwners.spawnProductionBoundary;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    fileParallelism: false,
    isolate: true,
    name: owner.name,
    passWithNoTests: true,
    useNonIsolatedRunner: false,
  });
}

export default createAgentsSpawnProductionBoundaryVitestConfig();
