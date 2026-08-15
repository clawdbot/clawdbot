// Vitest agents embedded agent config wires the agents embedded agent test shard.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedVitestConfig(env?: Record<string, string | undefined>) {
  const owner = agentVitestProjectOwners.embedded;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    exclude: owner.exclude,
    fileParallelism: false,
    // Cold shared harness imports exceed the generic limit on 2-vCPU hosted release runners.
    hookTimeout: 600_000,
    name: owner.name,
  });
}

export default createAgentsEmbeddedVitestConfig();
