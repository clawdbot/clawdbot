// Vitest acp config wires the acp test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAcpVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/acp/**/*.test.ts"], {
    dir: "src/acp",
    env,
    name: "acp",
  });
}

export default createAcpVitestConfig();
