import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/agents/**/*.test.ts"], {
    dir: "src/agents",
    env,
    name: "agents",
  });
}

export default createAgentsVitestConfig();
