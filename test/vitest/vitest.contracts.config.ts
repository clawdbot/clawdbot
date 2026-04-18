import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

const base = sharedVitestConfig as Record<string, unknown>;
const baseTest = sharedVitestConfig.test ?? {};
const contractIncludePatterns = [
  "src/channels/plugins/contracts/**/*.test.ts",
  "src/plugins/contracts/**/*.test.ts",
];

export function loadContractsIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createContractsVitestConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
) {
  const cliIncludePatterns = narrowIncludePatternsForCli(contractIncludePatterns, argv);
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
      include:
        loadContractsIncludePatternsFromEnv(env) ?? cliIncludePatterns ?? contractIncludePatterns,
      passWithNoTests: true,
    },
  });
}

export default createContractsVitestConfig();
