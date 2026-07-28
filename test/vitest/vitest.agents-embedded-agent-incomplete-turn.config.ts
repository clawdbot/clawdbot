// Vitest embedded agent incomplete-turn config isolates the expensive harness warmup.
import { agentsEmbeddedIncompleteTurnTestFiles } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsEmbeddedIncompleteTurnVitestConfig(
  env?: Record<string, string | undefined>,
) {
  return createScopedVitestConfig(agentsEmbeddedIncompleteTurnTestFiles, {
    dir: "src/agents/embedded-agent-runner",
    env,
    fileParallelism: false,
    name: "agents-embedded-agent-incomplete-turn",
  });
}

export default createAgentsEmbeddedIncompleteTurnVitestConfig();
