// Vitest unit fast config wires the unit fast test shard.
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv, narrowIncludePatternsForCli } from "./vitest.pattern-file.ts";
import { resolveRepoRootPath, sharedVitestConfig } from "./vitest.shared.config.ts";
import {
  getUnitFastIsolatedTestFiles,
  getUnitFastTestFiles,
  getUnitFastTimerTestFiles,
} from "./vitest.unit-fast-paths.mjs";

export function createUnitFastVitestConfig(
  env: Record<string, string | undefined> = process.env,
  options: { argv?: string[] } = {},
) {
  const sharedTest = sharedVitestConfig.test ?? {};
  const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE", env);
  const timerTestFiles = new Set(getUnitFastTimerTestFiles());
  const isolatedTestFiles = new Set(getUnitFastIsolatedTestFiles());
  const unitFastTestFiles = getUnitFastTestFiles().filter(
    (file) => !timerTestFiles.has(file) && !isolatedTestFiles.has(file),
  );
  const cliInclude = narrowIncludePatternsForCli(unitFastTestFiles, options.argv);

  return defineConfig({
    ...sharedVitestConfig,
    test: {
      ...sharedTest,
      name: "unit-fast",
      isolate: false,
      runner: undefined,
      // Env isolation only (no shared-setup mocks): membership is auto-curated,
      // so tests must never read the developer's real config/state.
      setupFiles: [resolveRepoRootPath("test/setup.env.ts")],
      include: includeFromEnv ?? cliInclude ?? unitFastTestFiles,
      exclude: sharedTest.exclude ?? [],
      passWithNoTests: true,
    },
  });
}

export default createUnitFastVitestConfig();
