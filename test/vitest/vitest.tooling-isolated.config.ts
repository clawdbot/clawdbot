// Vitest tooling isolated config wires the tooling isolated test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createToolingIsolatedVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["test/scripts/openclaw-e2e-instance.test.ts"], {
    env,
    isolate: true,
    name: "tooling-isolated",
    passWithNoTests: true,
    useNonIsolatedRunner: false,
  });
}

export default createToolingIsolatedVitestConfig();
