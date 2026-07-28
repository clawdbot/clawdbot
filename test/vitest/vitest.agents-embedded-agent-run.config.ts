// Vitest embedded agent run config keeps the run subtree in a bounded serial shard.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedRunVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.embeddedRun;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    fileParallelism: false,
    name: owner.name,
  });
}

export default createAgentsEmbeddedRunVitestConfig();
