import { defineConfig } from "vitest/config";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

const base = sharedVitestConfig as Record<string, unknown>;
const baseTest = sharedVitestConfig.test ?? {};

export function createContractsVitestConfig() {
  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      isolate: false,
      // The contracts shard intentionally runs non-isolated and loads hundreds of
      // contract files. Use forks so full-suite parallel runs do not hit
      // Vitest worker-thread heap limits.
      pool: "forks",
      runner: nonIsolatedRunnerPath,
      setupFiles: baseTest.setupFiles ?? [],
      include: [
        "src/channels/plugins/contracts/**/*.test.ts",
        "src/plugins/contracts/**/*.test.ts",
      ],
      passWithNoTests: true,
    },
  });
}

export default createContractsVitestConfig();
