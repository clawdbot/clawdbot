// Vitest contract shared helpers build contract test project configuration.
import { defineConfig } from "vitest/config";
import {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
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
};

const base = sharedVitestConfig as Record<string, unknown>;
const baseTest = sharedVitestConfig.test ?? {};

export const pluginContractPatterns = ["src/plugins/contracts/**/*.test.ts"];

function loadContractsIncludePatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] | null {
  return loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
}

export function createContractsVitestConfig(
  includePatterns: string[],
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv,
  options: { name?: string } = {},
) {
  const cliIncludePatterns = narrowIncludePatternsForCli(includePatterns, argv);
  const envIncludePatterns = intersectIncludePatterns(
    includePatterns,
    loadContractsIncludePatternsFromEnv(env),
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
