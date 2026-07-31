// Vitest embedded agent overflow config isolates the expensive harness warmup.
import { agentVitestProjectOwners } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedOverflowCompactionVitestConfig(
  env?: Record<string, string | undefined>,
) {
  const owner = agentVitestProjectOwners.embeddedOverflowCompaction;
  return createScopedVitestConfig(owner.include, {
    dir: owner.dir,
    env,
    fileParallelism: false,
    name: owner.name,
  });
}

export default createAgentsEmbeddedOverflowCompactionVitestConfig();
