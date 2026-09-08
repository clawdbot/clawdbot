// Vitest contract shared helpers build contract test project configuration.
import { defineConfig } from "vitest/config";
import {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
  pluginContractPatterns,
} from "./vitest.contracts-paths.mjs";
import {
  intersectIncludePatterns,
  loadPatternListFromEnv,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";
import { nonIsolatedRunnerPath, sharedVitestConfig } from "./vitest.shared.config.ts";

export {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
  pluginContractPatterns,
};

const base = sharedVitestConfig as Record<string, unknown>;
const baseTest = sharedVitestConfig.test ?? {};

export function createContractsVitestConfig(
  includePatterns: string[],
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
  options: { name?: string } = {},
) {
  const cliIncludePatterns = narrowIncludePatternsForCli(includePatterns, argv);
  const envIncludePatterns = intersectIncludePatterns(
    includePatterns,
    loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env),
  );
  return defineConfig({
    ...base,
    test: {
      ...baseTest,
      name: options.name ?? "contracts",
      isolate: false,
      runner: nonIsolatedRunnerPath,
      setupFiles: baseTest.setupFiles ?? [],
      include: envIncludePatterns ?? cliIncludePatterns ?? includePatterns,
      passWithNoTests: true,
    },
  });
}
