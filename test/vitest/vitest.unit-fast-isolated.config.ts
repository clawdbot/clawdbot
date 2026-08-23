// Vitest unit fast isolated config wires audited stateful tests out of shared module caches.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import { getUnitFastIsolatedTestFiles } from "./vitest.unit-fast-paths.mjs";

export function createUnitFastIsolatedVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const isolatedTestFiles = getUnitFastIsolatedTestFiles();
  const cliInclude = narrowIncludePatternsForCli(isolatedTestFiles, options.argv);

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: "unit-fast-isolated",
      // Forced stateful tests can mock modules imported by later files, so each gets a fresh graph.
      isolate: true,
      runner: undefined,
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      include: includeFromEnv ?? cliInclude ?? isolatedTestFiles,
      exclude: sharedTest.exclude ?? [],
      passWithNoTests: true,
    },
  });
}

export default createUnitFastIsolatedVitestConfig();
