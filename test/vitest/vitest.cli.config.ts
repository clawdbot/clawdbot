// Vitest cli config wires the cli test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createCliVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/cli/**/*.test.ts"], {
    dir: "src/cli",
    env,
    name: "cli",
    passWithNoTests: true,
  });
}

export default createCliVitestConfig();
