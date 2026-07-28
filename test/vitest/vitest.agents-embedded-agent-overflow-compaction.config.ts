// Vitest embedded agent overflow config isolates the expensive harness warmup.
import { agentsEmbeddedOverflowCompactionTestFiles } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedOverflowCompactionVitestConfig(
  env?: Record<string, string | undefined>,
) {
  return createScopedVitestConfig(agentsEmbeddedOverflowCompactionTestFiles, {
    dir: "src/agents/embedded-agent-runner",
    env,
    fileParallelism: false,
    name: "agents-embedded-agent-overflow-compaction",
  });
}

export default createAgentsEmbeddedOverflowCompactionVitestConfig();
